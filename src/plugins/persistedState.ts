import type { PiniaPluginContext, StateTree, _GettersTree, Store, StoreGeneric } from 'pinia'

type MigrationFn = (raw: any) => any

export interface PersistOptions {
  key?: string
  version?: number
  migrations?: Record<number, MigrationFn>
  paths?: string[] // whitelist путей для сохранения
  debounceMs?: number // по умолчанию ~200 мс
  syncTabs?: boolean // по умолчанию true
  serialize?: (value: any) => string
  deserialize?: (value: string) => any
}

declare module 'pinia' {
  export interface DefineStoreOptionsBase<S extends StateTree, Store> {
    persist?: PersistOptions | false
  }
}

// Безопасная обертка над Storage (частично дублируем поведение storageSafe для изоляции плагина)
// Плагин работает только с localStorage и собственным пространством ключей.
const STORAGE_PREFIX = '__app_'

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // quota errors, silent
  }
}
function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function joinKey(persistKey: string): string {
  return `${STORAGE_PREFIX}${persistKey}`
}

function pickPaths<S extends StateTree>(state: S, paths?: string[]): Partial<S> {
  if (!paths || paths.length === 0) return { ...state }
  const out: any = {}
  for (const path of paths) {
    // поддерживаем только плоские поля стора (по ТЗ whitelist простых атомарных полей)
    if (Object.prototype.hasOwnProperty.call(state, path)) {
      out[path] = (state as any)[path]
    }
  }
  return out
}

function mergePaths<S extends StateTree>(target: S, patch: Partial<S>, paths?: string[]) {
  if (!paths || paths.length === 0) {
    Object.assign(target, patch)
    return
  }
  for (const path of paths) {
    if (Object.prototype.hasOwnProperty.call(patch, path)) {
      (target as any)[path] = (patch as any)[path]
    }
  }
}

function applyMigrations(raw: any, toVersion?: number, migrations?: Record<number, MigrationFn>) {
  // Поддерживаем как wrapper { __v, data }, так и "голые" данные
  if (!toVersion || !migrations) return raw

  const initialVersion = typeof raw?.__v === 'number' ? raw.__v : 0
  if (initialVersion === toVersion) return raw

  // Нормализуем во wrapper
  let wrapper: any = (raw && typeof raw === 'object' && ('data' in raw || '__v' in raw))
    ? { __v: typeof raw.__v === 'number' ? raw.__v : initialVersion, data: raw.data ?? raw }
    : { __v: initialVersion, data: raw }

  // Последовательно применяем миграции
  const versions = Object.keys(migrations).map(Number).sort((a, b) => a - b)
  for (const v of versions) {
    if (v > (typeof wrapper.__v === 'number' ? wrapper.__v : 0) && v <= toVersion) {
      try {
        const res = migrations[v](wrapper)
        // Поддержка трёх вариантов:
        // 1) Мутация in-place: res === undefined
        // 2) Возвращён wrapper-объект с полями __v/data
        // 3) Возвращены "голые" данные (только data)
        if (res !== undefined) {
          if (res && typeof res === 'object' && ('data' in res || '__v' in res)) {
            wrapper = {
              __v: typeof res.__v === 'number' ? res.__v : v,
              data: (res as any).data ?? res,
            }
          } else {
            wrapper = {
              __v: v,
              data: res,
            }
          }
        } else {
          // если миграция ничего не вернула, считаем in-place изменения корректными
          wrapper.__v = v
        }
      } catch {
        // миграция упала — пропускаем шаг, сохраняем текущие данные и версию
      }
    }
  }

  // Финальная нормализация версии
  wrapper.__v = toVersion
  return wrapper
}

function defaultSerialize(value: any): string {
  return JSON.stringify(value)
}

function defaultDeserialize(value: string): any {
  return JSON.parse(value)
}

function debounce(fn: () => void, wait: number) {
  let t: number | undefined
  return () => {
    if (t) window.clearTimeout(t)
    t = window.setTimeout(() => {
      fn()
      t = undefined
    }, wait)
  }
}

/**
 * Pinia plugin: persistedState
 * - Гидратация из localStorage при инициализации стора
 * - Сохранение только whitelisted полей (paths)
 * - Debounce записи
 * - Версионирование с миграциями
 * - Межвкладочная синхронизация через window.storage
 */
/**
 * Именованный экспорт — ФАБРИКА плагина:
 * persistedState(options?) => (ctx: PiniaPluginContext) => void
 */
export function persistedState(optionsArg?: PersistOptions): (context: PiniaPluginContext) => void {
  // Дефолты фабрики (не зависят от стора)
  const tabListeners = new Map<string, (e: StorageEvent) => void>()

  // Никаких локальных совместимых фабрик тут не объявляем — plugin определяется ниже как Function Declaration

  // Определяем plugin как Function Declaration, чтобы он был доступен во всём scope выше
  function plugin(context: PiniaPluginContext): void {
    // Безопасность: корректный PiniaPluginContext
    if (!context || typeof (context as any).store !== 'object' || typeof (context as any).options !== 'object') {
      return
    }
    const { store, options } = context

    const persistFromStore = (options as any)?.persist as PersistOptions | false | undefined
    if (persistFromStore === false || persistFromStore === undefined) return

    // Нормализация опций: приоритет store.persist > optionsArg > дефолты
    const key =
      (persistFromStore?.key) ??
      (optionsArg?.key) ??
      store.$id

    const version =
      (persistFromStore?.version) ??
      (optionsArg?.version) ??
      0

    const paths =
      (persistFromStore?.paths) ??
      (optionsArg?.paths)

    const debounceMs =
      (persistFromStore?.debounceMs) ??
      (optionsArg?.debounceMs) ??
      250

    const syncTabs =
      (persistFromStore?.syncTabs) ??
      (optionsArg?.syncTabs) ??
      true

    const serialize =
      (persistFromStore?.serialize) ??
      (optionsArg?.serialize) ??
      defaultSerialize

    const deserialize =
      (persistFromStore?.deserialize) ??
      (optionsArg?.deserialize) ??
      defaultDeserialize

    const migrations =
      (persistFromStore?.migrations) ??
      (optionsArg?.migrations)

    const storageKey = joinKey(key)

    // Сбор состояния по paths
    const collect = () => {
      const data = pickPaths(store.$state as any, paths)
      return { __v: version ?? 0, data }
    }

    // Сохранение (без дебаунса)
    const saveNow = () => {
      try {
        const wrapper = collect()
        const raw = serialize(wrapper)
        safeSetItem(storageKey, raw)
      } catch {
        // ignore
      }
    }

    // Debounced сохранение
    const saveDebounced = debounce(saveNow, debounceMs)

    // Гидратация
    const raw = safeGetItem(storageKey)
    if (raw == null) {
      // Нет ключа — первичная запись СРАЗУ, с учетом кастомного serialize
      saveNow()
    } else {
      let parsed: any = null
      try {
        parsed = deserialize(raw)
      } catch {
        parsed = null
      }

      if (parsed == null) {
        // Битые данные — перезаписываем валидным wrapper немедленно
        saveNow()
      } else {
        // Применяем миграции и мержим по paths
        const migrated = applyMigrations(parsed, version, migrations)
        const payload = (migrated && typeof migrated === 'object' && 'data' in migrated) ? migrated.data : migrated
        if (payload && typeof payload === 'object') {
          mergePaths(store.$state as any, payload as any, paths)
        }
        // После гидратации фиксируем текущее состояние в хранилище (нормализованный wrapper)
        // чтобы обеспечить наличие ключа и корректную версию для последующих проверок
        saveNow()
      }
    }

    // Подписка на изменения — только debounce запись
    const unsubscribe = (store as Store).$subscribe(() => {
      saveDebounced()
    })

    // syncTabs
    if (syncTabs && typeof window !== 'undefined') {
      const handler = (e: StorageEvent) => {
        if (e.key !== storageKey) return
        // в jsdom e.storageArea может быть не типа Storage — не полагаемся на него
        if (e.newValue == null) return
        try {
          const parsed = deserialize(e.newValue)
          const migrated = applyMigrations(parsed, version, migrations)
          const payload = (migrated && typeof migrated === 'object' && 'data' in migrated) ? migrated.data : migrated
          if (payload && typeof payload === 'object') {
            mergePaths(store.$state as any, payload as any, paths)
          }
        } catch {
          // ignore
        }
      }
      window.addEventListener('storage', handler)
      tabListeners.set(storageKey, handler)

      const originalDispose = (store as any)._dispose
      ;(store as any)._dispose = (...args: any[]) => {
        const h = tabListeners.get(storageKey)
        if (h) {
          window.removeEventListener('storage', h)
          tabListeners.delete(storageKey)
        }
        // вызовем оригинальный dispose, если он существует
        if (typeof originalDispose === 'function') {
          return originalDispose.apply(store, args)
        }
      }
    }
  }

  // ВАЖНО: фабрика всегда возвращает plugin
  return plugin
}

/**
 * Совместимость с двумя стилями подключения:
 * 1) pinia.use(persistedState()) — фабрика возвращает плагин
 * 2) pinia.use(persistedState as any) — default-экспорт как сам плагин (обёртка вызывает фабрику)
 */
/**
 * Default экспорт — непосредственно PiniaPlugin.
 * Это устраняет типовые ошибки при pinia.use(persistedState()) в тестах.
 * При желании фабричный вызов также работает: pinia.use(persistedState())
 * благодаря тому, что именованный export возвращает сам плагин.
 */
/**
 * Совместимый default-экспорт:
 * - при вызове без аргументов: фабрика → возвращает (ctx) => void
 * - при передаче одного аргумента-контекста: ведёт себя как плагин
 */
function __persistedCompat(): (ctx: PiniaPluginContext) => void
function __persistedCompat(ctx: PiniaPluginContext): void
function __persistedCompat(...args: any[]): any {
  if (args.length === 0) return persistedState()
  if (args.length === 1 && args[0] && typeof args[0] === 'object') return persistedState()(args[0] as PiniaPluginContext)
  return persistedState()
}
export default __persistedCompat as unknown as {
  (): (ctx: PiniaPluginContext) => void
  (ctx: PiniaPluginContext): void
}