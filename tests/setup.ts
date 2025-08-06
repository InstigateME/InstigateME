import { afterEach, beforeAll, vi } from 'vitest'
import { config } from '@vue/test-utils'

// jsdom already provided by vitest.config.ts
// Mock localStorage with in-memory Map and storage event dispatch
class MemoryStorage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  clear() {
    const keys = Array.from(this.store.keys())
    for (const k of keys) this.removeItem(k)
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string) {
    const oldValue = this.store.get(key) ?? null
    const existed = this.store.delete(key)
    if (existed) {
      // jsdom строг к типу storageArea — не указываем его вовсе
      window.dispatchEvent(new StorageEvent('storage', {
        key,
        oldValue,
        newValue: null,
        url: globalThis.location?.href ?? 'http://localhost/',
      } as StorageEventInit))
    }
  }
  setItem(key: string, value: string) {
    const oldValue = this.store.get(key) ?? null
    this.store.set(key, value)
    // jsdom строг к типу storageArea — не указываем его вовсе
    window.dispatchEvent(new StorageEvent('storage', {
      key,
      oldValue,
      newValue: value,
      url: globalThis.location?.href ?? 'http://localhost/',
    } as StorageEventInit))
  }
}

beforeAll(() => {
  // Ensure timers can be controlled in tests that need debounce checks
  vi.useFakeTimers()

  // Install mock localStorage if not present or to ensure deterministic behavior
  Object.defineProperty(window, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: false,
  })

  // Vue Test Utils global config - provide minimal fully-typed structure
  config.global = {
    stubs: {},
    mocks: {},
    plugins: [],
    config: {},
    mixins: [],
    provide: {},
    components: {},
    directives: {},
    renderStubDefaultSlot: false,
  } as any
})

afterEach(() => {
  // reset storage after each test
  ;(window.localStorage as unknown as MemoryStorage).clear()
  vi.clearAllMocks()
})