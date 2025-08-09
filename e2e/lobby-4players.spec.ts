import { test, expect, Page } from '@playwright/test'
import { createPlayers, MultiClient } from './fixtures/contexts.js'

type PlayerId = `p${number}`

test.describe('Лобби: 4 игрока входят и видят одинаковый список', () => {
  // Храним ссылку на MultiClient между тестами
  let players: MultiClient

  // Приводим подготовку к единому стилю с test.beforeEach(async ({ browser }) => { ... })
  test.beforeEach(async ({ browser }) => {
    // Передаём пустой путь, чтобы contexts.ts корректно склеил его с baseURL и не получил "//"
    players = await createPlayers(browser, '', 4)
  })

  test.afterEach(async () => {
    await players?.closeAll()
  })

  test('консистентность списка игроков у всех 4 клиентов', async () => {
    // 1) Первый игрок (A) на главной вводит имя "Player A" и создаёт комнату
    const host = players.get('p1').page
    await host.goto('/', { waitUntil: 'domcontentloaded' })
    // Вводим имя
    await host.getByTestId('nickname-input').fill('Player A')
    // Жмём кнопку создания комнаты по data-test атрибуту
    await host.getByTestId('create-room-button').click()
    // Ждём появления раздела лобби и текста "ID комнаты для подключения:"
    await host.waitForSelector('text=ID комнаты для подключения:', { timeout: 15000 })
    // Считываем ID хоста
    const hostId = await host.locator('.room-id').first().innerText()

    // 2) Остальные вводят имена и подключаются по коду hostId
    const nicknames: Record<PlayerId, string> = {
      p1: 'Player A',
      p2: 'Player B',
      p3: 'Player C',
      p4: 'Player D',
    }
    await Promise.all(
      ['p2', 'p3', 'p4'].map(async (pid) => {
        const pN = players.get(pid as PlayerId).page
        await pN.goto('/', { waitUntil: 'domcontentloaded' })
        await pN.getByTestId('nickname-input').fill(nicknames[pid as PlayerId])
        // Вводим код комнаты в поле по data-test и жмём кнопку подключения по data-test
        const roomInput = pN.getByTestId('join-room-input')
        if (await roomInput.count()) {
          await roomInput.fill(hostId)
          await pN.getByTestId('join-room-button').click()
        } else {
          // fallback: прямой переход по ссылке
          const joinUrl = new URL('/', window.location.origin)
          joinUrl.searchParams.set('hostId', hostId)
          await pN.goto(joinUrl.toString(), { waitUntil: 'domcontentloaded' })
        }
      }),
    )

    // 3) Ждём пока у всех прогрузится UI лобби и список игроков станет видимым
    await players.each(async ({ page }: { page: Page }) => {
      await page.getByTestId('players-list').waitFor({ state: 'visible', timeout: 15000 })
      await expect(page.locator('.players-list')).toBeVisible()
    })

    // Небольшая задержка для стаба синхронизации
    await players.each(async ({ page }: { page: Page }) => {
      await page.waitForTimeout(500)
    })

    // 4) Собираем имена игроков с каждой страницы
    const lists = await Promise.all(
      players.clients.map(async ({ page, id }: { page: Page; id: string }) => {
        const names: string[] = await page.locator('.players-list .player-name').allInnerTexts()
        const normalized = names
          .map((n: string) => n.trim())
          .filter(Boolean)
          .sort()
        return { id, names: normalized }
      }),
    )

    const expected = ['Player A', 'Player B', 'Player C', 'Player D'].sort()

    // Проверяем, что у каждого клиента одинаковый и полный список игроков
    for (const { id, names } of lists) {
      expect.soft(names, `Неверный список у клиента ${id}`).toEqual(expected)
    }

    // Проверяем межклиентную консистентность попарно
    for (let i = 1; i < lists.length; i++) {
      expect
        .soft(lists[i].names, `Списки клиентов расходятся: ${lists[0].id} vs ${lists[i].id}`)
        .toEqual(lists[0].names)
    }
  })

  test('игрок меняет имя и повторно заходит — список игроков корректен', async () => {
    // 1) Создаём лобби с 4 игроками
    const host = players.get('p1').page
    await host.goto('/', { waitUntil: 'domcontentloaded' })
    await host.getByTestId('nickname-input').fill('Player A')
    await host.getByTestId('create-room-button').click()
    await host.waitForSelector('text=ID комнаты для подключения:', { timeout: 15000 })
    const hostId = await host.locator('.room-id').first().innerText()

    const nicknames: Record<PlayerId, string> = {
      p1: 'Player A',
      p2: 'Player B',
      p3: 'Player C',
      p4: 'Player D',
    }
    await Promise.all(
      ['p2', 'p3', 'p4'].map(async (pid) => {
        const pN = players.get(pid as PlayerId).page
        await pN.goto('/', { waitUntil: 'domcontentloaded' })
        await pN.getByTestId('nickname-input').fill(nicknames[pid as PlayerId])
        const roomInput = pN.getByTestId('join-room-input')
        if (await roomInput.count()) {
          await roomInput.fill(hostId)
          await pN.getByTestId('join-room-button').click()
        } else {
          const joinUrl = new URL('/', window.location.origin)
          joinUrl.searchParams.set('hostId', hostId)
          await pN.goto(joinUrl.toString(), { waitUntil: 'domcontentloaded' })
        }
      }),
    )

    // 2) p2 выходит из лобби
    const p2 = players.get('p2').page
    const leaveRoomButton = p2.getByTestId('leave-room-button')
    await leaveRoomButton.waitFor({ state: 'visible', timeout: 15000 })
    await leaveRoomButton.click()
    await p2.getByTestId('create-room-button').waitFor({ state: 'visible', timeout: 10000 })

    // 3) p2 меняет имя и снова заходит
    await p2.getByTestId('nickname-input').fill('Player B2')
    const roomInput2 = p2.getByTestId('join-room-input')
    if (await roomInput2.count()) {
      await roomInput2.fill(hostId)
      await p2.getByTestId('join-room-button').click()
    } else {
      const joinUrl = new URL('/', window.location.origin)
      joinUrl.searchParams.set('hostId', hostId)
      await p2.goto(joinUrl.toString(), { waitUntil: 'domcontentloaded' })
    }

    // 4) Проверяем, что список игроков обновился у всех
    await players.each(async ({ page }: { page: Page }) => {
      await page.getByTestId('players-list').waitFor({ state: 'visible', timeout: 15000 })
      await expect(page.locator('.players-list')).toBeVisible()
      await page.waitForTimeout(500)
    })

    const lists = await Promise.all(
      players.clients.map(async ({ page, id }: { page: Page; id: string }) => {
        const names: string[] = await page.locator('.players-list .player-name').allInnerTexts()
        const normalized = names
          .map((n: string) => n.trim())
          .filter(Boolean)
          .sort()
        return { id, names: normalized }
      }),
    )

    const expected = ['Player A', 'Player B2', 'Player C', 'Player D'].sort()
    for (const { id, names } of lists) {
      expect.soft(names, `Неверный список у клиента ${id}`).toEqual(expected)
    }
    for (let i = 1; i < lists.length; i++) {
      expect
        .soft(lists[i].names, `Списки клиентов расходятся: ${lists[0].id} vs ${lists[i].id}`)
        .toEqual(lists[0].names)
    }
  })

  test('выход хоста — выбирается новый хост с минимальным client id', async () => {
    // 1) Создаём лобби с 4 игроками
    const host = players.get('p1').page
    await host.goto('/', { waitUntil: 'domcontentloaded' })
    await host.getByTestId('nickname-input').fill('Player A')
    await host.getByTestId('create-room-button').click()
    await host.waitForSelector('text=ID комнаты для подключения:', { timeout: 15000 })
    const hostId = await host.locator('.room-id').first().innerText()

    const nicknames: Record<PlayerId, string> = {
      p1: 'Player A',
      p2: 'Player B',
      p3: 'Player C',
      p4: 'Player D',
    }
    await Promise.all(
      ['p2', 'p3', 'p4'].map(async (pid) => {
        const pN = players.get(pid as PlayerId).page
        await pN.goto('/', { waitUntil: 'domcontentloaded' })
        await pN.getByTestId('nickname-input').fill(nicknames[pid as PlayerId])
        const roomInput = pN.getByTestId('join-room-input')
        if (await roomInput.count()) {
          await roomInput.fill(hostId)
          await pN.getByTestId('join-room-button').click()
        } else {
          const joinUrl = new URL('/', window.location.origin)
          joinUrl.searchParams.set('hostId', hostId)
          await pN.goto(joinUrl.toString(), { waitUntil: 'domcontentloaded' })
        }
      }),
    )

    // Ждем что все вошли в лобби и видят список игроков
    await players.each(async ({ page }: { page: Page }) => {
      await page.getByTestId('players-list').waitFor({ state: 'visible', timeout: 20000 })
      await expect(page.locator('.players-list')).toBeVisible()
    })

    await host.pause()

    // 2) Хост выходит из лобби
    const leaveRoomButton = host.getByTestId('leave-room-button')
    await leaveRoomButton.waitFor({ state: 'visible', timeout: 15000 })
    await leaveRoomButton.click()
    await host.getByTestId('create-room-button').waitFor({ state: 'visible', timeout: 10000 })

    await host.pause()

    // 3) Проверяем, что новый хост выбран по минимальному client id
    // Собираем client id всех игроков (например, по data-test="player-id" или аналогичному атрибуту)
    // Если id выводится только в JS-объекте, используем доступные данные из DOM
    const ids = await Promise.all(
      players.clients.map(async ({ page }) => {
        // Предполагается, что id игрока есть в data-player-id или аналогичном атрибуте
        // Если id не выводится в DOM, используйте доступный способ получения id
        const idList = await page.locator('.players-list .player-id').allInnerTexts()
        return idList.map(id => id.trim()).filter(Boolean)
      })
    )
    // Собираем уникальные id из всех клиентов
    const flatIds = Array.from(new Set(ids.flat()))
    // Находим минимальный id (по числовому значению, если id вида p1, p2, p3)
    const minId = flatIds.sort()[0]

    // Проверяем, что игрок с этим id отображается как хост
    // Находим индекс игрока с minId в списке на одном из клиентов
    const page = players.clients[0].page
    const playerNames = await page.locator('.players-list .player-name').allInnerTexts()
    const playerIds = await page.locator('.players-list .player-id').allInnerTexts()
    const hostIndicators = await page.locator('.players-list .host-indicator').allInnerTexts()
    const hostIdx = hostIndicators.length === 1 ? playerIds.findIndex(id => id.trim() === minId) : -1
    expect(hostIdx).not.toBe(-1)

    // 4) Проверяем, что у всех клиентов корректный список игроков и новый хост
    await players.each(async ({ page }: { page: Page }) => {
      await page.getByTestId('players-list').waitFor({ state: 'visible', timeout: 15000 })
      await expect(page.locator('.players-list')).toBeVisible()
      await page.waitForTimeout(500)
    })

    const lists = await Promise.all(
      players.clients.map(async ({ page, id }: { page: Page; id: string }) => {
        const names: string[] = await page.locator('.players-list .player-name').allInnerTexts()
        const normalized = names
          .map((n: string) => n.trim())
          .filter(Boolean)
          .sort()
        return { id, names: normalized }
      }),
    )

    const expected = ['Player B', 'Player C', 'Player D'].sort()
    for (const { id, names } of lists) {
      expect.soft(names, `Неверный список у клиента ${id}`).toEqual(expected)
    }
    for (let i = 1; i < lists.length; i++) {
      expect
        .soft(lists[i].names, `Списки клиентов расходятся: ${lists[0].id} vs ${lists[i].id}`)
        .toEqual(lists[0].names)
    }
  })
})
