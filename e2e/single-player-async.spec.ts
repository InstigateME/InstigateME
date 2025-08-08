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

  test.beforeEach(async ({ browser }, testInfo) => {
    const isSingleMonitor = testInfo.project.metadata?.singleMonitor
    const screenSize = isSingleMonitor ? { width: 755, height: 390 } : undefined // MacBook Pro 14"
    players = await createPlayers(browser, '', 4, screenSize)
  })

  test.afterEach(async () => {
    await players?.closeAll()
  })

  test('4 клиента: вход, одинаковое состояние, ходы по кругу, синхронизация и завершение раунда', async () => {
    // === ЮЗКЕЙС 1: СОЗДАНИЕ И ПОДКЛЮЧЕНИЕ КОМНАТЕ ===
    // Проверяется:
    // - Создание комнаты хостом
    // - Подключение остальных игроков по ID
    // - Отображение и консистентность списка игроков
    // Первый игрок (A) на главной вводит имя "Player A" и создаёт комнату
    const host = players.get('p1').page
    await host.goto('/', { waitUntil: 'domcontentloaded' })
    await host.getByTestId('nickname-input').fill('Player A')
    await host.getByTestId('create-room-button').click()
    await host.waitForSelector('text=ID комнаты для подключения:', { timeout: 15000 })
    const hostId = await host.locator('.room-id').first().innerText()

    // Остальные вводят имена и подключаются по коду hostId
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

    // Проверка, что у всех прогрузился UI лобби и список игроков видим
    await players.each(async ({ page }: { page: Page }) => {
      await page.getByTestId('players-list').waitFor({ state: 'visible', timeout: 15000 })
      await expect(page.locator('.players-list')).toBeVisible()
    })

    // Стаб синхронизации
    await players.each(async ({ page }: { page: Page }) => {
      await page.waitForTimeout(500)
    })

    // Проверка консистентности списка игроков
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

    for (const { id, names } of lists) {
      expect.soft(names, `Неверный список у клиента ${id}`).toEqual(expected)
    }

    for (let i = 1; i < lists.length; i++) {
      expect
        .soft(lists[i].names, `Списки клиентов расходятся: ${lists[0].id} vs ${lists[i].id}`)
        .toEqual(lists[0].names)
    }

    // === ЮЗКЕЙС 2: СТАРТ ИГРЫ И НАЧАЛО РАУНДА ===
    // Проверяется:
    // - Запуск игры хостом
    // - Начало первого раунда
    await host.getByTestId('start-game-button').click()

    // === ЮЗКЕЙС 3: ДЕЙСТВИЯ В РАУНДЕ (ГОЛОСОВАНИЕ, СТАВКИ, СИНХРОНИЗАЦИЯ) ===
    // Проверяется:
    // - Игрок тянет карту и начинает ход
    // - Голосование всех игроков
    // - Ставки всех игроков
    // - Синхронизация состояния между клиентами
    await host.getByTestId('action-primary').click()

    // --- Голосование ---
    await players.each(async ({ page }: { page: Page }) => {
      const phaseVoting = page.getByTestId('phase-voting')
      await phaseVoting.waitFor({ state: 'visible', timeout: 15000 })
      const voteButtons = phaseVoting.getByTestId('players-list-voting').locator('.vote-chip')
      await expect(voteButtons).toHaveCount(3)
      await voteButtons.nth(0).click()
      await voteButtons.nth(1).click()
      const submitButton = page.getByTestId('vote-submit')
      await submitButton.waitFor({ state: 'visible', timeout: 15000 })
      await submitButton.click()
    })

    // --- Ставки ---
    await players.each(async ({ page }: { page: Page }) => {
      await page.getByTestId('players-list-bet').waitFor({ state: 'visible', timeout: 15000 })
      const betChipButton = page.getByTestId('players-list-bet').locator('.bet-chip')
      await expect(betChipButton).toHaveCount(3)
      await betChipButton.nth(2).click()
      const submitBetButton = page.getByTestId('bet-submit')
      await submitBetButton.waitFor({ state: 'visible', timeout: 15000 })
      await submitBetButton.click()
    })

    // --- Проверка синхронизации результатов ---
    await players.each(async ({ page }: { page: Page }) => {
      const votedNote = page.getByTestId('phase-results')
      await expect(votedNote).toBeVisible()
    })

    // === ЮЗКЕЙС 4: ПЕРЕХОД К СЛЕДУЮЩЕМУ РАУНДУ ===
    // Проверяется:
    // - Переход к следующему раунду
    // - Обновление UI у всех клиентов
    await host.getByTestId('next-round-btn').click()

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

    // === ЮЗКЕЙС 5: ПОВТОР РАУНДА (ГОЛОСОВАНИЕ, ОТВЕТЫ, УГАДЫВАНИЯ, ВЫБОР ПОБЕДИТЕЛЕЙ) ===
    // Проверяется:
    // - Голосование
    // - Ответы игроков
    // - Угадывания
    // - Выбор победителей
    // - Синхронизация результатов
    // --- Голосование ---
    await players.each(async ({ page }: { page: Page }) => {
      const phaseVoting = page.getByTestId('phase-voting')
      await phaseVoting.waitFor({ state: 'visible', timeout: 15000 })
      const voteButtons = phaseVoting.getByTestId('players-list-voting').locator('.vote-chip')
      await expect(voteButtons).toHaveCount(3)
      await voteButtons.nth(0).click()
      await voteButtons.nth(1).click()
      const submitButton = page.getByTestId('vote-submit')
      await submitButton.waitFor({ state: 'visible', timeout: 15000 })
      await submitButton.click()
    })

    await players.each(async ({ page }: { page: Page }) => {
      //await page.pause()
    })

    // --- Ответы игроков ---
    await players.each(async ({ page }: { page: Page }) => {
      const votedNote = page.getByTestId('phase-answering')
      await expect(votedNote).toBeVisible()
    })

    let pageSetAnswering: Page | undefined
    await players.each(async ({ page }: { page: Page }) => {
      const actionPrimary = page.getByTestId('answering-textarea')
      if (await actionPrimary.isVisible()) {
        pageSetAnswering = page
      }
    })
    if (!pageSetAnswering) {
      throw new Error('Не удалось найти страницу с полем для ответа')
    }

    await pageSetAnswering.getByTestId('answering-textarea').fill('Test answer')

    const submitAnswering = pageSetAnswering.getByTestId('answering-submit')
    await submitAnswering.waitFor({ state: 'visible', timeout: 15000 })
    await submitAnswering.click()

    await pageSetAnswering.locator('.guessing-wait').waitFor({ state: 'visible', timeout: 15000 })

    // --- Угадывания ---
    await players.each(async ({ page }: { page: Page }) => {
      const actionPrimary = page.locator('.guessing-textarea')
      if (!(await actionPrimary.isVisible())) {
        return
      }
      await page.locator('.guessing-textarea').fill('Test answer')
      const guessingAnswering = page.locator('.guessing-submit')
      await guessingAnswering.waitFor({ state: 'visible', timeout: 15000 })
      await guessingAnswering.click()
    })

    await pageSetAnswering.locator('.winners-select').waitFor({ state: 'visible', timeout: 15000 })

    // --- Выбор победителей ---
    const buttonWinnerChip = pageSetAnswering.locator('.winners-select .winner-chip')
    await buttonWinnerChip.nth(0).click()
    await buttonWinnerChip.nth(1).click()

    const submitWinnersConfirm = pageSetAnswering.locator('.winners-confirm')
    await submitWinnersConfirm.waitFor({ state: 'visible', timeout: 15000 })
    await submitWinnersConfirm.click()

    // --- Проверка синхронизации результатов ---
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
