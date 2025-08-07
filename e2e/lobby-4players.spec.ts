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
    for (const pid of ['p2', 'p3', 'p4'] as PlayerId[]) {
      const pN = players.get(pid).page
      await pN.goto('/', { waitUntil: 'domcontentloaded' })
      await pN.getByTestId('nickname-input').fill(nicknames[pid])
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
    }

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
})
