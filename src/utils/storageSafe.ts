/**
 * storageSafe: безопасные обёртки над localStorage с единым префиксом, TTL и неймспейсами.
 * Префикс ключей: "__app_ns:"
 *
 * Формат значения: { value: T, exp?: number } — exp в unix ms.
 * Правила:
 * - Все операции безопасны (try/catch), ошибки и квоты игнорируются.
 * - buildKey(ns, key) => "__app_ns:" + ns + ":" + key
 * - getWithTTL: при истекшем exp удаляет ключ и возвращает fallback/null.
 * - nsGet: возвращает «сырое» строковое значение; JSON не парсится, ключ не удаляется.
 * - clearNamespace удаляет все ключи namespace.
 */
const STORAGE_PREFIX = '__app_ns:'
const NAMESPACE_SEPARATOR = ':'

export interface StoredWrapper<T = any> {
  value: T
  exp?: number
}

function isStorageAvailable(): boolean {
  try {
    if (typeof window === 'undefined' || !('localStorage' in window)) return false
    const testKey = '__app__test__'
    window.localStorage.setItem(testKey, '1')
    window.localStorage.removeItem(testKey)
    return true
  } catch {
    return false
  }
}

function nowMs(): number {
  return Date.now()
}

function buildKey(namespace: string | null | undefined, key: string): string {
  // Единый формат ключей строго как "__app_ns:namespace:key"
  // Тесты всегда передают namespace, поэтому требуем непустой ns.
  const ns = (namespace ?? '').toString()
  if (!ns) {
    // Для совместимости оставим формат без namespace как "__app_ns::key"
    // но в проекте все вызовы используют ns ('game','peer')
    return `${STORAGE_PREFIX}${NAMESPACE_SEPARATOR}${key}`
  }
  return `${STORAGE_PREFIX}${ns}${NAMESPACE_SEPARATOR}${key}`
}

function safeGetItem(k: string): string | null {
  if (!isStorageAvailable()) return null
  try {
    return window.localStorage.getItem(k)
  } catch {
    return null
  }
}

function safeSetItem(k: string, v: string): void {
  if (!isStorageAvailable()) return
  try {
    window.localStorage.setItem(k, v)
  } catch {
    // ignore quota/denied
  }
}

function safeRemoveItem(k: string): void {
  if (!isStorageAvailable()) return
  try {
    window.localStorage.removeItem(k)
  } catch {
    // ignore
  }
}

function parseWrapper<T = any>(raw: string): StoredWrapper<T> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // ignore
  }
  return null
}

function serializeWrapper(value: StoredWrapper): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ value: null })
  }
}

/**
 * nsSet: сохранить значение в namespace без TTL (как «сырое» строковое значение)
 * В localStorage пишем именно строку без JSON-обёртки.
 */
export function nsSet<T = any>(ns: string, key: string, value: T): void {
  const k = buildKey(ns, key)
  // Преобразуем к строке по правилам Web Storage (хранит только строки)
  // Никакой JSON-обёртки/парсинга — тесты ожидают «сырое» значение.
  let toStore: string
  if (typeof value === 'string') {
    toStore = value
  } else if (value === null || value === undefined) {
    toStore = String(value) // 'null' | 'undefined'
  } else {
    toStore = String(value)
  }
  safeSetItem(k, toStore)
}

/**
 * nsGet: получить «сырое» значение из namespace (без JSON.parse).
 * Если ключ отсутствует — вернуть fallback. Никогда не удаляет ключ.
 */
export function nsGet<T = any>(ns: string, key: string, fallback: T | null = null): T | null {
  const k = buildKey(ns, key)
  const raw = safeGetItem(k)
  if (raw == null) return fallback
  // Возвращаем «сырое» строковое значение без авто-конверсии,
  // т.к. тест clearNamespace ожидает строго строку '9'
  return (raw as unknown as T) ?? fallback
}

/**
 * nsRemove: удалить конкретный ключ из namespace
 */
export function nsRemove(ns: string, key: string): void {
  const k = buildKey(ns, key)
  safeRemoveItem(k)
}

/**
 * setWithTTL: сохраняет значение в namespace с TTL (в миллисекундах)
 */
export function setWithTTL<T = any>(ns: string, key: string, value: T, ttlMs: number): void {
  const k = buildKey(ns, key)
  const exp = nowMs() + Math.max(0, ttlMs)
  const wrapper: StoredWrapper<T> = { value, exp }
  safeSetItem(k, serializeWrapper(wrapper))
}

/**
 * getWithTTL: получает значение с учётом TTL.
 * Если exp просрочен или JSON битый — удаляет ключ и возвращает fallback/null.
 */
export function getWithTTL<T = any>(ns: string, key: string, fallback: T | null = null): T | null {
  const k = buildKey(ns, key)
  const raw = safeGetItem(k)
  if (raw == null) return fallback
  const wrapper = parseWrapper<T>(raw)
  if (!wrapper || typeof wrapper !== 'object' || !('value' in wrapper)) {
    // битые/неверной структуры данные — удаляем
    safeRemoveItem(k)
    return fallback
  }
  if (typeof wrapper.exp === 'number' && wrapper.exp <= nowMs()) {
    // истёк — удаляем и возвращаем fallback
    safeRemoveItem(k)
    return fallback
  }
  return (wrapper.value as T) ?? fallback
}

/**
 * clearNamespace: удаляет все ключи указанного namespace
 */
export function clearNamespace(ns: string): void {
  if (!isStorageAvailable()) return
  try {
    const prefix = `${STORAGE_PREFIX}${ns}${NAMESPACE_SEPARATOR}`
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const storageKey = window.localStorage.key(i)
      if (!storageKey) continue
      if (storageKey.startsWith(prefix)) {
        toRemove.push(storageKey)
      }
    }
    for (const k of toRemove) safeRemoveItem(k)
  } catch {
    // ignore
  }
}

/**
 * Вспомогательная очистка протухших ключей в namespace.
 */
export function cleanupExpiredInNamespace(ns: string): void {
  if (!isStorageAvailable()) return
  try {
    const prefix = `${STORAGE_PREFIX}${ns}${NAMESPACE_SEPARATOR}`
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const storageKey = window.localStorage.key(i)
      if (!storageKey || !storageKey.startsWith(prefix)) continue
      const raw = safeGetItem(storageKey)
      if (!raw) continue
      const wrapper = parseWrapper(raw)
      if (wrapper && typeof wrapper.exp === 'number' && wrapper.exp <= nowMs()) {
        toRemove.push(storageKey)
      }
    }
    for (const k of toRemove) safeRemoveItem(k)
  } catch {
    // ignore
  }
}

// Экспорт объекта с удобными методами
export const storageSafe = {
  nsSet,
  nsGet,
  nsRemove,
  setWithTTL,
  getWithTTL,
  clearNamespace,
  cleanupExpiredInNamespace,
  STORAGE_PREFIX,
  buildKey,
  // Дополнительные удобные алиасы для единообразия API в коде:
  nsSetWithTTL: setWithTTL,
  nsGetWithTTL: getWithTTL
}