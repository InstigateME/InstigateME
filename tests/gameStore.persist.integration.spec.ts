import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGameStore } from '../src/stores/gameStore'
import persistedState from '../src/plugins/persistedState'
import { storageSafe } from '../src/utils/storageSafe'

const STORAGE_PREFIX = '__app_'
const NS = 'game'
const PERSIST_KEY = `${STORAGE_PREFIX}${NS}`

describe('gameStore + persistedState + storageSafe (integration)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0))
    localStorage.clear()

    const pinia = createPinia()
    pinia.use(persistedState as any)
    setActivePinia(pinia)
  })

  it('первая инициализация: создается wrapper со whitelisted полями', () => {
    const store = useGameStore()

    // persisted.paths из gameStore:
    // ['myPlayerId','myNickname','isHost','hostId','roomId','connectionStatus','sessionTimestamp']
    // ожидаем wrapper { __v:1, data:{ ...только эти поля... } }
    const raw = localStorage.getItem(PERSIST_KEY)
    expect(raw).toBeTruthy()

    const obj = JSON.parse(raw!)
    expect(obj).toHaveProperty('__v', 1)
    expect(obj).toHaveProperty('data')
    const d = obj.data

    const allowed = ['myPlayerId','myNickname','isHost','hostId','roomId','connectionStatus','sessionTimestamp']
    // проверяем что только whitelist-ключи существуют
    expect(Object.keys(d).sort()).toEqual(allowed.sort())

    // значения по умолчанию из стора допустим undefined/initial; главное — только разрешенные ключи
  })

  it('изменение whitelisted полей приводит к записи debounce wrapper', () => {
    const store = useGameStore()

    store.myPlayerId = 'p1'
    store.myNickname = 'nick'
    store.isHost = true
    store.hostId = 'h1'
    store.roomId = 'r1'
    store.connectionStatus = 'connected' as any
    store.sessionTimestamp = 111

    // ждём debounce из persist (200ms)
    vi.advanceTimersByTime(210)

    const obj = JSON.parse(localStorage.getItem(PERSIST_KEY)!)
    expect(obj.__v).toBe(1)
    const d = obj.data
    expect(d).toMatchObject({
      myPlayerId: 'p1',
      myNickname: 'nick',
      isHost: true,
      hostId: 'h1',
      roomId: 'r1',
      connectionStatus: 'connected',
      sessionTimestamp: 111
    })

    // проверяем что не-whitelisted поле не попало
    // добавим что-то явно вне путей, если оно существует в сторе
    ;(store as any).someTransientField = 'x'
    vi.advanceTimersByTime(210)
    const obj2 = JSON.parse(localStorage.getItem(PERSIST_KEY)!)
    expect(obj2.data.someTransientField).toBeUndefined()
  })

  it('storageSafe roomIdStable с namespace game', () => {
    // сценарий использования storageSafe в gameStore для стабильного roomId
    storageSafe.nsSet(NS, 'roomIdStable', 'ROOM-ABC')
    expect(storageSafe.nsGet(NS, 'roomIdStable')).toBe('ROOM-ABC')

    // другой namespace не должен видеть это значение
    expect(storageSafe.nsGet('other', 'roomIdStable', null)).toBeNull()

    // очистка неймспейса "game" не трогает другой
    storageSafe.nsSet('other', 'k', 1)
    storageSafe.clearNamespace(NS)
    expect(storageSafe.nsGet(NS, 'roomIdStable', null)).toBeNull()
    expect(storageSafe.nsGet('other', 'k', null)).toBe(1)
  })

  it('hostGameStateSnapshot хранится через TTL-обертку и истекает', () => {
    // имитируем contract: setWithTTL/getWithTTL на ключ 'hostGameStateSnapshot'
    const snapshot = { ts: Date.now(), state: { foo: 'bar' } }
    storageSafe.setWithTTL(NS, 'hostGameStateSnapshot', snapshot, 1000)
    // до истечения
    expect(storageSafe.getWithTTL(NS, 'hostGameStateSnapshot')).toEqual(snapshot)

    // после истечения TTL
    vi.advanceTimersByTime(1100)
    expect(storageSafe.getWithTTL(NS, 'hostGameStateSnapshot', null)).toBeNull()

    // запись удалена
    const key = (storageSafe as any).buildKey(NS, 'hostGameStateSnapshot')
    expect(localStorage.getItem(key)).toBeNull()
  })
})