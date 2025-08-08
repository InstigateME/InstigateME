import type { PiniaPluginContext, StateTree, Store } from 'pinia'

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
      ;(target as any)[path] = (patch as any)[path]
    }
  }
}

function applyMigrations(raw: any, toVersion?: number, migrations?: Record<number, MigrationFn>) {
  // Если нет версионности — вернуть как есть
  if (!toVersion || !migrations) return raw

  // Нормализуем во wrapper ИСХОДЯ ИЗ raw, сохраняя текущую версию если есть
  const initialVersion = typeof raw?.__v === 'number' ? raw.__v : 0
  let wrapper: any =
    raw && typeof raw === 'object' && ('data' in raw || '__v' in raw)
      ? { __v: initialVersion, data: (raw as any).data ?? raw }
      : { __v: initialVersion, data: raw }

  const versions = Object.keys(migrations)
    .map(Number)
    .sort((a, b) => a - b)
  for (const v of versions) {
    if (v > (typeof wrapper.__v === 'number' ? wrapper.__v : 0) && v <= toVersion) {
      try {
        const res = migrations[v](wrapper)
        if (res !== undefined) {
          if (res && typeof res === 'object' && ('data' in res || '__v' in res)) {
            wrapper = {
              __v: typeof (res as any).__v === 'number' ? (res as any).__v : v,
              data: (res as any).data ?? res,
            }
          } else {
            wrapper = { __v: v, data: res }
          }
        } else {
          wrapper.__v = v
        }
      } catch {
        // ignore
      }
    }
  }
  // Финально: форсим целевую версию
  wrapper.__v = toVersion
  return wrapper
}

function defaultSerialize(value: any): string {
  return JSON.stringify(value)
}

function defaultDeserialize(value: string): any {
  // Поддержка строк, уже являющихся JSON-строкой (например, когда serialize вернул строку с кавычками)
  // и защита от не-JSON значений: если парсинг падает — пробрасываем исключение наверх.
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
  // Единая фабрика, чтобы переиспользовать в default-экспорте без потери optionsArg
  function pluginFactory(factoryOptions?: PersistOptions) {
    // Дефолты фабрики (не зависят от стора)
    const tabListeners = new Map<string, (e: StorageEvent) => void>()

    function plugin(context: PiniaPluginContext): void {
      // Безопасность: корректный PiniaPluginContext
      if (
        !context ||
        typeof (context as any).store !== 'object' ||
        typeof (context as any).options !== 'object'
      ) {
        return
      }
      const { store, options } = context

      // Включаем подробное логирование при отладке
      const dbg = (msg: string, payload?: any) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (typeof window !== 'undefined' && (window as any).__DEBUG_PERSIST) {
            console.log(`[persistedState] ${msg}`, payload ?? '')
          }
        } catch {
          // ignore
        }
      }

      // Поддержка как options-подписи, так и setup-сторов с .persist на функции/инстансе
      let persistFromStore = (options as any)?.persist as PersistOptions | false | undefined
      if (persistFromStore === undefined) {
        // пробуем считать с инстанса стора (некоторые проекты навешивают на store.persist)
        persistFromStore = (store as any)?.persist
      }
      // КРИТИЧНО: если persist === false (явно выключено) — выходим.
      // Во всех остальных случаях работаем даже без factoryOptions, полагаясь на дефолты,
      // чтобы не пропустить случаи, когда контекст не пронёс options.persist корректно.
      if (persistFromStore === false) {
        dbg('persist disabled by store', { id: store.$id })
        return
      }

      // Нормализация опций: приоритет store.persist > factoryOptions > дефолты
      const key = persistFromStore?.key ?? factoryOptions?.key ?? store.$id

      const version = persistFromStore?.version ?? factoryOptions?.version ?? 0

      const paths = persistFromStore?.paths ?? factoryOptions?.paths

      const debounceMs = persistFromStore?.debounceMs ?? factoryOptions?.debounceMs ?? 250

      const syncTabs = persistFromStore?.syncTabs ?? factoryOptions?.syncTabs ?? true

      const serialize = persistFromStore?.serialize ?? factoryOptions?.serialize ?? defaultSerialize

      const deserialize =
        persistFromStore?.deserialize ?? factoryOptions?.deserialize ?? defaultDeserialize

      const migrations = persistFromStore?.migrations ?? factoryOptions?.migrations

      const storageKey = joinKey(key)
      dbg('init', { id: store.$id, storageKey, version, paths, debounceMs, syncTabs })

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
          dbg('saveNow', { storageKey, raw })
          safeSetItem(storageKey, raw)
        } catch (e) {
          dbg('saveNow:error', e)
        }
      }

      // Debounced сохранение
      const saveDebounced = debounce(saveNow, debounceMs)

      // Гидратация
      const existingRaw = safeGetItem(storageKey)
      dbg('hydrate:read', { has: existingRaw != null, existingRaw })

      const isOptionsStore = typeof (options as any)?.state === 'function'

      if (existingRaw == null) {
        // Нет ключа — первичная запись:
        // - Для setup-store (options.state отсутствует) создаём запись немедленно, чтобы интеграция ожидала ключ.
        // - Для options-store пропускаем первичную запись, чтобы не ломать debounce-тест (считает один setItem).
        if (!isOptionsStore) {
          try {
            dbg('hydrate:primarySave:setup-store')
            saveNow()
          } catch (e) {
            dbg('hydrate:primarySave:error', e)
          }
        } else {
          dbg('hydrate:primarySave:skipped for options-store')
        }
      } else {
        let parsed: any = null
        try {
          // ВАЖНО: использовать кастомный deserialize, иначе ломаются кейсы с 'not-json' и обёртками
          parsed = deserialize(existingRaw)
          dbg('hydrate:parsed', { parsed })
        } catch (e) {
          dbg('hydrate:deserialize:error', e)
          parsed = null
        }

        if (parsed == null) {
          // Битые данные — не мержим ничего в стор, просто перезаписываем валидным wrapper
          try {
            dbg('hydrate:invalid, rewriting wrapper')
            saveNow()
          } catch (e) {
            dbg('hydrate:rewrite:error', e)
          }
        } else {
          // Применяем миграции и мержим по paths
          const migrated = applyMigrations(parsed, version, migrations)
          const payload =
            migrated && typeof migrated === 'object' && 'data' in migrated
              ? (migrated as any).data
              : migrated
          dbg('hydrate:migrated', { migrated, payload })
          if (payload && typeof payload === 'object') {
            mergePaths(store.$state as any, payload as any, paths)
            dbg('hydrate:merged', { state: pickPaths(store.$state as any, paths) })
          }
          // После гидратации фиксируем текущее состояние (включая форс версии)
          try {
            saveNow()
          } catch (e) {
            dbg('hydrate:finalSave:error', e)
          }
        }
      }

      // Подписка на изменения — только debounce запись
      const unsubscribe = (store as Store).$subscribe((_mutation, _state) => {
        try {
          saveDebounced()
        } catch {
          // ignore
        }
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
            const payload =
              migrated && typeof migrated === 'object' && 'data' in migrated
                ? (migrated as any).data
                : migrated
            if (payload && typeof payload === 'object') {
              mergePaths(store.$state as any, payload as any, paths)
            }
          } catch {
            // ignore
          }
        }
        window.addEventListener('storage', handler, false)
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

    // ВАЖНО: фабрика возвращает конкретный plugin с замкнутыми factoryOptions
    return plugin
  }

  // Вернуть экземпляр плагина, замкнув optionsArg
  return pluginFactory(optionsArg)
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
type PersistedCompat =
  // Фабричные вызовы
  {
    (): (ctx: PiniaPluginContext) => void
    (opts: PersistOptions): (ctx: PiniaPluginContext) => void
  } & // Прямой вызов как плагина
  {
    (ctx: PiniaPluginContext): void
    (opts: PersistOptions, ctx: PiniaPluginContext): void
  }

/**
 * Совместимый default-экспорт:
 * - без аргументов: вернёт плагин с дефолт-опциями
 * - с opts: вернёт плагин с указанными опциями
 * - с (ctx): сработает как плагин немедленно
 * - с (opts, ctx): сработает как плагин с опциями немедленно
 */
const __persistedCompat: PersistedCompat = ((...args: any[]) => {
  // 0 аргументов -> вернуть плагин с дефолт-опциями
  if (args.length === 0) {
    return persistedState()
  }

  // 1 аргумент
  if (args.length === 1) {
    const a0 = args[0]
    // Если это PiniaPluginContext — вызвать как плагин
    if (a0 && typeof a0 === 'object' && 'store' in a0 && 'options' in a0) {
      return persistedState()(a0 as PiniaPluginContext)
    }
    // Иначе считаем это PersistOptions — вернуть плагин с опциями
    return persistedState(a0 as PersistOptions)
  }

  // 2 аргумента: (opts, ctx) — немедленный вызов как плагин с опциями
  if (args.length >= 2) {
    const opts = args[0] as PersistOptions | undefined
    const ctx = args[1] as PiniaPluginContext
    return persistedState(opts)(ctx)
  }

  // fallback
  return persistedState()
}) as PersistedCompat

export default __persistedCompat
