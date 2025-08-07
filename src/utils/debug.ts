import { storageSafe } from './storageSafe'

/**
 * Флаг отладки включается, если в localStorage присутствует ключ "__app_debug".
 * Ключ считается "включающим" при любом непустом значении, кроме '0' | 'false' | 'off'.
 * Используем безопасные обёртки из storageSafe, чтобы не падать в окружениях без window/localStorage.
 */
const GLOBAL_DEBUG_KEY = '__app_debug'
/** Событие для реактивного оповещения UI о смене debug-флага */
export const DEBUG_FLAG_EVENT = '__app_debug_changed'

function normalize(val: unknown): string {
  if (val === null || val === undefined) return ''
  return String(val).trim().toLowerCase()
}

/**
 * Прямая проверка флага отладки.
 * Читает глобальный ключ без namespace через storageSafe.buildKey(''|null, key) → "__app_ns::key".
 * Также проверяем «сырое» наличие ключа в localStorage без префикса, если есть прямой доступ.
 * Это обеспечивает совместимость, если флаг был установлен вручную: localStorage.setItem('__app_debug','1')
 */
export function isDebugEnabled(): boolean {
  // В localhost всегда включаем debug независимо от флага
  try {
    if (typeof window !== 'undefined') {
      const host = window.location?.hostname || ''
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return true
      }
    }
  } catch {
    // ignore and fallback to flag checks
  }

  // 1) Попытка прочитать через storageSafe с пустым namespace (сформируется "__app_ns::__app_debug")
  //    Если проект не использует этот формат для отладочного ключа, fallback ниже покроет случай «сырое» значение.
  const prefixedKey = (storageSafe as any).buildKey?.('', GLOBAL_DEBUG_KEY) as string | undefined
  if (prefixedKey) {
    try {
      const raw =
        typeof window !== 'undefined' && 'localStorage' in window
          ? window.localStorage.getItem(prefixedKey)
          : null
      if (raw != null) {
        const v = normalize(raw)
        if (v && v !== '0' && v !== 'false' && v !== 'off') return true
      }
    } catch {
      // ignore
    }
  }

  // 2) Фаллбек: проверяем «сырое» наличие ключа без префикса, как указано в задаче (__app_debug в localStorage)
  try {
    if (typeof window !== 'undefined' && 'localStorage' in window) {
      const raw = window.localStorage.getItem(GLOBAL_DEBUG_KEY)
      if (raw != null) {
        const v = normalize(raw)
        return !!(v && v !== '0' && v !== 'false' && v !== 'off')
      }
    }
  } catch {
    // ignore
  }

  return false
}

// Авто-экспорт в window один раз при загрузке модуля (если возможно),
// чтобы можно было вызывать из DevTools: enableDebug(), disableDebug(), isDebugEnabled()
try {
  if (typeof window !== 'undefined') {
    ;(window as any).enableDebug = enableDebug
    ;(window as any).disableDebug = disableDebug
    ;(window as any).isDebugEnabled = isDebugEnabled
  }
} catch {
  // ignore
}

/**
 * Утилиты для установки/снятия флага (удобно в консоли или быстрых переключателях).
 * Они пишут «сырой» ключ без префиксов для простоты: __app_debug = '1' | removeItem.
 */
export function enableDebug(): void {
  try {
    if (typeof window !== 'undefined' && 'localStorage' in window) {
      window.localStorage.setItem(GLOBAL_DEBUG_KEY, '1')
      // Экспортируем в window для быстрого доступа из консоли
      ;(window as any).enableDebug = enableDebug
      ;(window as any).disableDebug = disableDebug
      ;(window as any).isDebugEnabled = isDebugEnabled
      // Оповестим приложение о смене флага
      window.dispatchEvent(new CustomEvent(DEBUG_FLAG_EVENT, { detail: { enabled: true } }))
    }
  } catch {
    // ignore
  }
}
export function disableDebug(): void {
  try {
    if (typeof window !== 'undefined' && 'localStorage' in window) {
      window.localStorage.removeItem(GLOBAL_DEBUG_KEY)
      ;(window as any).enableDebug = enableDebug
      ;(window as any).disableDebug = disableDebug
      ;(window as any).isDebugEnabled = isDebugEnabled
      // Оповестим приложение о смене флага
      window.dispatchEvent(new CustomEvent(DEBUG_FLAG_EVENT, { detail: { enabled: false } }))
    }
  } catch {
    // ignore
  }
}
