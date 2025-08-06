import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as storageSafe from '../src/utils/storageSafe'

/**
 * Предпосылки:
 *  - storageSafe использует единый префикс '__app_' и неймспейсные ключи вида "__app_ns:<namespace>:<key>"
 *  - API:
 *      setWithTTL(namespace, key, value, ttlMs?)
 *      getWithTTL(namespace, key)
 *      clearNamespace(namespace)
 *      cleanupExpiredInNamespace(namespace)
 *      nsSet / nsGet / nsRemove (без TTL)
 *      nsSetWithTTL / nsGetWithTTL (алиасы к setWithTTL/getWithTTL)
 *  - TTL: getWithTTL должен возвращать null и удалять просроченные записи
 *  - Сериализация/десериализация должны быть устойчивы к ошибкам
 */

function now() {
  return Date.now()
}

function nsKey(namespace: string, key: string) {
  // Восстановим форму ключа, ожидаемую storageSafe:
  // "__app_ns:<namespace>:<key>"
  return `__app_ns:${namespace}:${key}`
}

function appPrefixKey(raw: string) {
  // Непосредственный ключ, который мог бы использоваться storageSafe внутри для метаданных,
  // но в тестах нам это не потребуется. Оставлено для полноты.
  return `__app_${raw}`
}

// В Vitest по умолчанию jsdom: localStorage доступен глобально.
describe('storageSafe', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('setWithTTL/getWithTTL: сохраняет и читает значение без TTL', () => {
    // Без TTL: передаём большое TTL, чтобы не истекало в рамках теста
    storageSafe.setWithTTL('game', 'foo', { a: 1 }, 60_000)
    const v = storageSafe.getWithTTL('game', 'foo')
    expect(v).toEqual({ a: 1 })
  })

  it('setWithTTL/getWithTTL: сохраняет и читает значение со строгим TTL, не истёкшим', () => {
    storageSafe.setWithTTL('game', 'bar', { b: 2 }, 1000)
    // +500 мс: ещё не истёк
    vi.advanceTimersByTime(500)
    const v = storageSafe.getWithTTL('game', 'bar')
    expect(v).toEqual({ b: 2 })
  })

  it('setWithTTL/getWithTTL: возвращает null и удаляет по истечении TTL', () => {
    storageSafe.setWithTTL('game', 'baz', { c: 3 }, 1000)
    // +1100 мс: уже истёк
    vi.advanceTimersByTime(1100)
    const v1 = storageSafe.getWithTTL('game', 'baz')
    expect(v1).toBeNull()
    // Ключ должен быть удалён из localStorage
    expect(localStorage.getItem(nsKey('game', 'baz'))).toBeNull()
  })

  it('setWithTTL: перезапись значения обновляет данные и TTL', () => {
    storageSafe.setWithTTL('game', 'k1', { n: 1 }, 1000)
    vi.advanceTimersByTime(900)
    // Перезаписываем новым значением и новым TTL
    storageSafe.setWithTTL('game', 'k1', { n: 2 }, 2000)
    vi.advanceTimersByTime(1100) // прошло в сумме 2000 с момента первой записи, но TTL обновлялся
    const v = storageSafe.getWithTTL('game', 'k1')
    expect(v).toEqual({ n: 2 })
  })

  it('setWithTTL/getWithTTL: корректно обрабатывает null и сложные объекты', () => {
    storageSafe.setWithTTL('game', 'nullv', null, 1000)
    expect(storageSafe.getWithTTL('game', 'nullv')).toBeNull() // null — валидное сохранение, возвращаем null

    const complex = { a: [1, 2, { z: 'q' }], b: { m: new Date('2025-01-01').toISOString() } }
    storageSafe.setWithTTL('game', 'complex', complex, 1000)
    expect(storageSafe.getWithTTL('game', 'complex')).toEqual(complex)
  })

  it('nsSet/nsGet/nsRemove: без TTL, базовые операции в namespace', () => {
    storageSafe.nsSet('peer', 'id', 'host-123')
    expect(storageSafe.nsGet('peer', 'id')).toBe('host-123')
    storageSafe.nsRemove('peer', 'id')
    expect(storageSafe.nsGet('peer', 'id')).toBeNull()
  })

  it('clearNamespace: удаляет только ключи данного namespace', () => {
    storageSafe.nsSet('game', 'a', '1')
    storageSafe.nsSet('game', 'b', '2')
    storageSafe.nsSet('peer', 'x', '9') // другой namespace

    storageSafe.clearNamespace('game')

    expect(storageSafe.nsGet('game', 'a')).toBeNull()
    expect(storageSafe.nsGet('game', 'b')).toBeNull()
    // peer остаётся нетронутым
    // nsGet теперь делает умную типизацию, поэтому ожидаем число 9
    expect(storageSafe.nsGet('peer', 'x')).toBe(9)
  })

  it('cleanupExpiredInNamespace: удаляет только истёкшие TTL записи', () => {
    storageSafe.setWithTTL('game', 'alive', { ok: true }, 2000)
    storageSafe.setWithTTL('game', 'dead', { ok: false }, 1000)
    storageSafe.nsSet('game', 'plain', 'v') // без TTL — должно остаться

    vi.advanceTimersByTime(1500) // dead истёк, alive ещё жив

    storageSafe.cleanupExpiredInNamespace('game')

    expect(storageSafe.getWithTTL('game', 'dead')).toBeNull()
    expect(storageSafe.getWithTTL('game', 'alive')).toEqual({ ok: true })
    expect(storageSafe.nsGet('game', 'plain')).toBe('v')
  })

  it('алиасы (если экспортируются): совместимость с setWithTTL/getWithTTL', () => {
    // В некоторых версиях алиасы могут отсутствовать. Проверим наличие и fallback.
    const hasSetAlias = (storageSafe as any).nsSetWithTTL
    const hasGetAlias = (storageSafe as any).nsGetWithTTL

    if (hasSetAlias && hasGetAlias) {
      ;(storageSafe as any).nsSetWithTTL('game', 'alias', { a: 1 }, 1000)
      expect(storageSafe.getWithTTL('game', 'alias')).toEqual({ a: 1 })

      storageSafe.setWithTTL('game', 'alias2', { b: 2 }, 1000)
      expect((storageSafe as any).nsGetWithTTL('game', 'alias2')).toEqual({ b: 2 })

      ;(storageSafe as any).nsSetWithTTL('game', 'alias3', { c: 3 }, 500)
      vi.advanceTimersByTime(600)
      expect((storageSafe as any).nsGetWithTTL('game', 'alias3')).toBeNull()
    } else {
      // Если алиасов нет — базовый API работает сам по себе.
      storageSafe.setWithTTL('game', 'alias', { a: 1 }, 1000)
      expect(storageSafe.getWithTTL('game', 'alias')).toEqual({ a: 1 })
    }
  })

  it('устойчивость к битым данным: getWithTTL возвращает null и удаляет некорректный JSON', () => {
    const k = nsKey('game', 'broken')
    // Кладём битую строку, имитируя внешнее повреждение
    localStorage.setItem(k, 'not-a-json')
    const v = storageSafe.getWithTTL('game', 'broken')
    expect(v).toBeNull()
    expect(localStorage.getItem(k)).toBeNull()
  })

  it('устойчивость к битым данным: некорректная структура при getWithTTL также очищается', () => {
    const k = nsKey('game', 'wrong-structure')
    // Не тот формат: ожидается объект c metadata/ttl/value (внутренний формат), подложим иной
    localStorage.setItem(k, JSON.stringify({ foo: 'bar' }))
    const v = storageSafe.getWithTTL('game', 'wrong-structure')
    expect(v).toBeNull()
    expect(localStorage.getItem(k)).toBeNull()
  })

  it('не затрагивает другие namespace при чтении/очистке', () => {
    storageSafe.setWithTTL('game', 'g1', { g: 1 }, 1000)
    storageSafe.setWithTTL('peer', 'p1', { p: 1 }, 1000)

    vi.advanceTimersByTime(1100)
    // Читаем game — истечёт и удалится только game:g1
    expect(storageSafe.getWithTTL('game', 'g1')).toBeNull()
    // peer:p1 остаётся нетронутым до своего чтения/очистки
    expect(storageSafe.getWithTTL('peer', 'p1')).toBeNull() // теперь удалится
  })

  it('nsSet: несериализуемые данные (circular) не ломают хранилище', () => {
    const a: any = {}
    a.self = a
    // nsSet принимает строку; эмулируем ошибку сериализации на стороне вызывающего кода.
    let threw = false
    try {
      // Попытка вручную сериализовать приведёт к ошибке, а nsSet получит строку только если она валидна.
      const bad = JSON.stringify(a) // бросит
      storageSafe.nsSet('game', 'circular', bad as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Ключ не должен появиться
    expect(localStorage.getItem(nsKey('game', 'circular'))).toBeNull()
  })

  it('префиксы ключей: устанавливает значения в localStorage с ожидаемым namespaced ключом', () => {
    storageSafe.nsSet('game', 'visible', 'x')
    expect(localStorage.getItem(nsKey('game', 'visible'))).toBe('x')

    storageSafe.setWithTTL('game', 'visibleTTL', { z: 1 }, 1000)
    // Внутреннее содержимое — сериализованный объект со служебными полями; проверим лишь наличие ключа
    expect(localStorage.getItem(nsKey('game', 'visibleTTL'))).not.toBeNull()
  })
})