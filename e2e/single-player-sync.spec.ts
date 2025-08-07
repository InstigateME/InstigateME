import { test, expect, Page } from '@playwright/test'
import { createPlayers, MultiClient, PlayerId } from './fixtures/contexts.js'

/**
 * E2E: базовый happy-path синхронной игры для 4 игроков в одном матче.
 * Структура: Given (лобби) → When (старт и ходы по кругу) → Then (синхронизация и завершение раунда).
 * Используются data-testid из компонентов Lobby.vue/GameField.vue.
 */

test.describe('Мультиплеер: базовый синхро-сценарий на 4 игроков', () => {
  test.setTimeout(12_000_000)

  let players: MultiClient

  test.beforeEach(async ({ browser }) => {
    players = await createPlayers(browser, '', 4)
  })

  test.afterEach(async () => {
    await players?.closeAll()
  })

  test('4 клиента: вход, одинаковое состояние, ходы по кругу, синхронизация и завершение раунда', async () => {
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

    // 5) Хост нажимает на кнопку начала игры
    await host.getByTestId('start-game-button').click()

    // 6) Игрок "Вытягивает карту" и начинает ход
    await host.getByTestId('action-primary').click()

    // 7) Тестирование голосования
    for (const { page } of players.clients) {
      const phaseVoting = page.getByTestId('phase-voting')

      // Ждём появления UI голосования
      await phaseVoting.waitFor({ state: 'visible', timeout: 15000 })

      // Проверяем, что кнопки игроков отображаются
      const voteButtons = phaseVoting.getByTestId('players-list-voting').locator('.vote-chip')
      await expect(voteButtons).toHaveCount(3) // 3 других игрока

      // Выбираем двух игроков
      await voteButtons.nth(0).click()
      await voteButtons.nth(1).click()

      // Проверяем, что кнопка "Отправить голос" активна
      const submitButton = page.getByTestId('vote-submit')
      await submitButton.waitFor({ state: 'visible', timeout: 15000 })
      await submitButton.waitFor({ state: 'attached', timeout: 15000 })
      await expect(submitButton).toBeVisible({ timeout: 15000 })
      await expect(submitButton).toBeEnabled({ timeout: 15000 })
      await submitButton.click({ delay: 1500 })
    }

    for (const { page } of players.clients) {
      // Проверяем, что кнопки ставок отображаются и активны
      await page.getByTestId('players-list-bet').waitFor({ state: 'visible', timeout: 15000 })
      const betChipButton = page.getByTestId('players-list-bet').locator('.bet-chip')
      await expect(betChipButton).toHaveCount(3)
      await betChipButton.nth(2).click()

      // Проверяем, что кнопка "Сделать ставку" активна
      const submitBetButton = page.getByTestId('bet-submit')
      await submitBetButton.waitFor({ state: 'visible', timeout: 15000 })
      await submitBetButton.waitFor({ state: 'attached', timeout: 15000 })
      await expect(submitBetButton).toBeVisible({ timeout: 15000 })
      await expect(submitBetButton).toBeEnabled({ timeout: 15000 })
      await submitBetButton.click({ delay: 1500 })
    }

    // 8) Проверяем, что состояние синхронизируется между клиентами
    await players.each(async ({ page }: { page: Page }) => {
      const votedNote = page.getByTestId('phase-results')
      await expect(votedNote).toBeVisible()
    })

    // 9) Переходим на следующий раунд, что кнопка "Следующий раунд" доступна
    await host.getByTestId('next-round-btn').click()

    // 10) Проверяем, что все клиенты видят новый раунд и UI обновился
    await players.each(async ({ page }: { page: Page }) => {
      const votedNote = page.getByTestId('phase-drawing-question')
      await expect(votedNote).toBeVisible()
    })

    await players.each(async ({ page }: { page: Page }) => {
      const actionPrimary = page.getByTestId('action-primary')
      if (await actionPrimary.isVisible()) {
        await actionPrimary.click()
      }
    })

    // 10) Тестирование голосования
    for (const { page } of players.clients) {
      const phaseVoting = page.getByTestId('phase-voting')

      // Ждём появления UI голосования
      await phaseVoting.waitFor({ state: 'visible', timeout: 15000 })

      // Проверяем, что кнопки игроков отображаются
      const voteButtons = phaseVoting.getByTestId('players-list-voting').locator('.vote-chip')
      await expect(voteButtons).toHaveCount(3) // 3 других игрока

      // Выбираем двух игроков
      await voteButtons.nth(0).click()
      await voteButtons.nth(1).click()

      // Проверяем, что кнопка "Отправить голос" активна
      const submitButton = page.getByTestId('vote-submit')
      await submitButton.waitFor({ state: 'visible', timeout: 15000 })
      await submitButton.waitFor({ state: 'attached', timeout: 15000 })
      await expect(submitButton).toBeVisible({ timeout: 15000 })
      await expect(submitButton).toBeEnabled({ timeout: 15000 })
      await submitButton.click({ delay: 1500 })
    }

    await players.each(async ({ page }: { page: Page }) => {
      const votedNote = page.getByTestId('phase-answering')
      await expect(votedNote).toBeVisible()
    })

    let pageSetAnswering: Page
    await players.each(async ({ page }: { page: Page }) => {
      const actionPrimary = page.getByTestId('answering-textarea')
      if (!(await actionPrimary.isVisible())) {
        return
      }
      pageSetAnswering = page
    })
    // eslint-disable-next-line playwright/no-conditional-in-test
    if (!pageSetAnswering) {
      throw new Error('Не удалось найти страницу с полем для ответа')
    }

    await pageSetAnswering.getByTestId('answering-textarea').fill('Test answer')

    const submitAnswering = pageSetAnswering.getByTestId('answering-submit')
    await submitAnswering.waitFor({ state: 'visible', timeout: 15000 })
    await submitAnswering.waitFor({ state: 'attached', timeout: 15000 })
    await expect(submitAnswering).toBeVisible({ timeout: 15000 })
    await expect(submitAnswering).toBeEnabled({ timeout: 15000 })
    await submitAnswering.click({ delay: 1500 })

    await pageSetAnswering.locator('.guessing-wait').waitFor({ state: 'visible', timeout: 15000 })

    for (const { page } of players.clients) {
      const actionPrimary = page.locator('.guessing-textarea')
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!(await actionPrimary.isVisible())) {
        continue
      }

      await page.locator('.guessing-textarea').fill('Test answer')

      const guessingAnswering = page.locator('.guessing-submit')
      await guessingAnswering.waitFor({ state: 'visible', timeout: 15000 })
      await guessingAnswering.waitFor({ state: 'attached', timeout: 15000 })
      await expect(guessingAnswering).toBeVisible({ timeout: 15000 })
      await expect(guessingAnswering).toBeEnabled({ timeout: 15000 })
      await guessingAnswering.click({ delay: 1500 })
    }

    await pageSetAnswering.locator('.winners-select').waitFor({ state: 'visible', timeout: 15000 })

    const buttonWinnerChip = pageSetAnswering.locator('.winners-select .winner-chip')
    await buttonWinnerChip.nth(0).click()
    await buttonWinnerChip.nth(1).click()

    const submitWinnersConfirm = pageSetAnswering.locator('.winners-confirm')
    await submitWinnersConfirm.waitFor({ state: 'visible', timeout: 15000 })
    await submitWinnersConfirm.waitFor({ state: 'attached', timeout: 15000 })
    await expect(submitWinnersConfirm).toBeVisible({ timeout: 15000 })
    await expect(submitWinnersConfirm).toBeEnabled({ timeout: 15000 })
    await submitWinnersConfirm.click({ delay: 1500 })

    await players.each(async ({ page }: { page: Page }) => {
      const votedNote = page.getByTestId('phase-results')
      await expect(votedNote).toBeVisible()
    })

    await host.getByTestId('next-round-btn').click()

    await players.each(async ({ page }: { page: Page }) => {
      const actionPrimary = page.getByTestId('action-primary')
      if (await actionPrimary.isVisible()) {
        await actionPrimary.click()
      }
    })
  })
})
