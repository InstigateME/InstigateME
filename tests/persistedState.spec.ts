import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, defineStore, setActivePinia } from 'pinia'
// включаем диагностическое логирование persistedState
;(window as any).__DEBUG_PERSIST = true
import persistedState from '../src/plugins/persistedState'

const STORAGE_PREFIX = '__app_'
const storageKey = (k: string) => `${STORAGE_PREFIX}${k}`

// Loose helper type to bypass strict Pinia typings in tests (runtime behavior is what we validate)
type AnyStore = Record<string, any>

function flushDebounce(ms = 250) {
  vi.advanceTimersByTime(ms)
}

describe('persistedState plugin', () => {
  beforeEach(() => {
    const pinia = createPinia()
    // В проекте persistedState используется как фабрика плагина
    pinia.use(persistedState())
    setActivePinia(pinia)
    window.localStorage.clear()
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  it('гидратирует стор из localStorage', () => {
    const key = 'counter'
    const initial = { __v: 1, data: { count: 5 } }
    window.localStorage.setItem(storageKey(key), JSON.stringify(initial))

    const useCounter = defineStore('counter', {
      state: () => ({ count: 0, other: 1 }),
      persist: {
        key,
        version: 1,
        paths: ['count'],
      },
    } as any)

    const store = useCounter() as unknown as AnyStore
    expect(store.count).toBe(5)
    expect(store.other).toBe(1)
  })

  it('paths/whitelist: сохраняет только whitelisted поля', () => {
    const key = 'whitelist'
    const useS = defineStore('s', {
      state: () => ({ a: 1, b: 2 }),
      persist: {
        key,
        version: 1,
        paths: ['a'],
        debounceMs: 50,
      },
    } as any)

    const s = useS() as unknown as AnyStore
    s.a = 10
    s.b = 20
    flushDebounce(60)

    const raw = window.localStorage.getItem(storageKey(key))
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.data).toEqual({ a: 10 })
    expect(parsed.data.b).toBeUndefined()
  })

  it('debounce: несколько изменений -> одна запись', () => {
    const key = 'debounce'
    const setSpy = vi.spyOn(window.localStorage, 'setItem')

    const useS = defineStore('s', {
      state: () => ({ x: 0 }),
      persist: {
        key,
        version: 1,
        paths: ['x'],
        debounceMs: 200,
      },
    } as any)

    const s = useS() as unknown as AnyStore
    s.x = 1
    s.x = 2
    s.x = 3
    expect(setSpy).not.toHaveBeenCalled()

    flushDebounce(200)
    vi.runAllTimers()
    expect(setSpy).toHaveBeenCalledTimes(1)

    const stored = JSON.parse(window.localStorage.getItem(storageKey(key))!)
    expect(stored.data.x).toBe(3)
  })

  it('версии/миграции: применяет миграцию и форсит версию', () => {
    const key = 'migr'
    window.localStorage.setItem(storageKey(key), JSON.stringify({ __v: 0, data: { a: 1 } }))

    const migrations: Record<number, (d: any) => any> = {
      1: (raw) => {
        const next = { ...raw }
        next.data.a = 2
        return next
      },
      2: (raw) => {
        const next = { ...raw }
        next.data.b = 3
        return next
      },
    }

    const useS = defineStore('s', {
      state: () => ({ a: 0, b: 0 }),
      persist: {
        key,
        version: 2,
        migrations,
        paths: ['a', 'b'],
      },
    } as any)

    const s = useS() as unknown as AnyStore
    expect(s.a).toBe(2)
    expect(s.b).toBe(3)

    s.a = 5
    flushDebounce()

    const stored = JSON.parse(window.localStorage.getItem(storageKey(key))!)
    expect(stored.__v).toBe(2)
    expect(stored.data).toEqual({ a: 5, b: 3 })
  })

  it('устойчивость к ошибкам десериализации: игнорирует битые данные', () => {
    const key = 'broken'
    window.localStorage.setItem(storageKey(key), 'not-json')

    const useS = defineStore('s', {
      state: () => ({ v: 1 }),
      persist: {
        key,
        version: 1,
        paths: ['v'],
      },
    } as any)

    const s = useS() as unknown as AnyStore
    expect(s.v).toBe(1)

    s.v = 2
    flushDebounce()
    const stored = JSON.parse(window.localStorage.getItem(storageKey(key))!)
    expect(stored).toHaveProperty('__v', 1)
    expect(stored.data).toEqual({ v: 2 })
  })

  it('межвкладочная синхронизация через storage событие', () => {
    const key = 'sync'
    const useS = defineStore('s', {
      state: () => ({ v: 0 }),
      persist: {
        key,
        version: 1,
        paths: ['v'],
        debounceMs: 50,
        syncTabs: true,
      },
    } as any)

    const a = useS() as unknown as AnyStore
    const b = useS() as unknown as AnyStore

    a.v = 42
    flushDebounce(60)

    expect(b.v).toBe(42)
  })

  it('custom serialize/deserialize опции применяются', () => {
    const key = 'customSer'
    const serialize = vi.fn((v: any) => `#${JSON.stringify(v)}#`)
    const deserialize = vi.fn((v: string) => JSON.parse(v.slice(1, -1)))

    const useS = defineStore('s', {
      state: () => ({ n: 0 }),
      persist: {
        key,
        version: 1,
        paths: ['n'],
        debounceMs: 50,
        serialize,
        deserialize,
      },
    } as any)

    const s = useS() as unknown as AnyStore
    s.n = 7
    flushDebounce(60)

    let raw = window.localStorage.getItem(storageKey(key))
    if (!raw) {
      flushDebounce(200)
      vi.runAllTimers()
      raw = window.localStorage.getItem(storageKey(key))
    }
    expect(raw).toBeTruthy()
    expect((raw as string).startsWith('#')).toBe(true)
    expect(serialize).toHaveBeenCalled()

    const useS2 = defineStore('s2', {
      state: () => ({ n: 0 }),
      // @ts-ignore
      persist: {
        key,
        version: 1,
        paths: ['n'],
        serialize,
        deserialize,
      },
    } as any)
    window.localStorage.setItem(storageKey(key), raw!)
    const s2 = useS2() as unknown as AnyStore
    expect(deserialize).toHaveBeenCalled()
    expect(s2.n).toBe(7)
  })
})

/**
 * ===================== ДОПОЛНИТЕЛЬНЫЕ КЕЙСЫ =====================
 * Полная, целостная версия блока с тремя тестами.
 */
describe('persistedState — дополнительные кейсы', () => {
  it('первичная запись wrapper при отсутствии ключа — только paths', () => {
    const key = 'ps1'
    const useStore = defineStore('ps1', {
      state: () => ({
        a: 1,
        b: 2,
        c: 3,
      }),
      actions: {},
    }) as any

    ;(useStore as any).persist = {
      key,
      version: 5,
      debounceMs: 50,
      paths: ['a', 'c'],
    }

    const s = useStore()
    const raw = localStorage.getItem(storageKey(key))
    expect(raw).toBeTruthy()

    const parsed = JSON.parse(raw!)
    expect(parsed.__v).toBe(5)
    expect(parsed.data).toBeTruthy()
    expect(Object.keys(parsed.data).sort()).toEqual(['a', 'c'])
    expect(parsed.data).toMatchObject({ a: 1, c: 3 })
    expect(parsed.data.b).toBeUndefined()
  })

  it('syncTabs применяет merge только по paths', () => {
    const key = 'ps-sync'
    const useStore = defineStore('ps-sync', {
      state: () => ({
        a: 1,
        b: 2,
        c: 3,
      }),
    }) as any

    ;(useStore as any).persist = {
      key,
      version: 1,
      debounceMs: 0,
      paths: ['a'],
      syncTabs: true,
    }

    const s = useStore()
    const otherPayload = {
      __v: 1,
      data: {
        a: 10,
        b: 999, // не входит в paths
        c: 9999,
      },
    }
    localStorage.setItem(storageKey(key), JSON.stringify(otherPayload))
    // В jsdom StorageEventInit.storageArea строгого типа Storage может вызывать ошибку,
    // обработчик плагина не полагается на storageArea — создадим событие без него.
    window.dispatchEvent(new StorageEvent('storage', {
      key: storageKey(key),
      newValue: JSON.stringify(otherPayload),
      oldValue: null
    } as any))

    expect(s.a).toBe(10)
    expect(s.b).toBe(2)
    expect(s.c).toBe(3)
  })

  it('кастомный serialize используется при первичной записи', () => {
    const key = 'ps-serialize'
    const useStore = defineStore('ps-serialize', {
      state: () => ({
        a: 'x',
        b: 'y',
      }),
    }) as any

    const serialize = vi.fn((v: any) => JSON.stringify({ wrapped: v }))
    const deserialize = vi.fn((s: string) => {
      const obj = JSON.parse(s)
      return obj.wrapped
    })

    ;(useStore as any).persist = {
      key,
      version: 2,
      debounceMs: 0,
      paths: ['a'],
      serialize,
      deserialize,
    }

    const s = useStore()

    expect(serialize).toHaveBeenCalledTimes(1)
    const raw = localStorage.getItem(storageKey(key))
    expect(raw).toBeTruthy()

    const parsed = JSON.parse(raw!)
    expect(parsed).toHaveProperty('wrapped')
    expect(parsed.wrapped.__v).toBe(2)
    expect(parsed.wrapped.data).toMatchObject({ a: 'x' })
    expect(parsed.wrapped.data.b).toBeUndefined()
  })
})