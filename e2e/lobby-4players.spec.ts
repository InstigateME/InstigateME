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
    // Подписка на события консоли для всех клиентов
    players.each(({ page, id }) => {
      page.on('console', (msg) => {
        console.log(`[${id}] [${msg.type()}] ${msg.text()}`)
        for (const arg of msg.args()) {
          arg.jsonValue().then((value) => {
            if (typeof value === 'object' && value !== null) {
              console.log(`[${id}]   аргумент:`, JSON.stringify(value))
            }
          })
        }
      })
    })

    // 1) Первый игрок (A) на главной вводит имя "Player A" и создаёт комнату
    const host = players.get('p1').page
    await host.goto('/?test', { waitUntil: 'domcontentloaded' }) // Добавляем параметр test для быстрого таймаута
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
        await pN.goto('/?test', { waitUntil: 'domcontentloaded' }) // Добавляем параметр test
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
    // Подписка на события консоли для всех клиентов
    players.each(({ page, id }) => {
      page.on('console', (msg) => {
        console.log(`[${id}] [${msg.type()}] ${msg.text()}`)
        for (const arg of msg.args()) {
          arg.jsonValue().then((value) => {
            if (typeof value === 'object' && value !== null) {
              console.log(`[${id}]   аргумент:`, JSON.stringify(value))
            }
          })
        }
      })
    })

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
        await pN.goto('/?test', { waitUntil: 'domcontentloaded' }) // Добавляем параметр test
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

    // Ждём пока у всех прогрузится UI лобби и список игроков станет видимым
    await players.each(async ({ page }: { page: Page }) => {
      await page.getByTestId('players-list').waitFor({ state: 'visible', timeout: 15000 })
      await expect(page.locator('.players-list')).toBeVisible()
    })

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

  test('выход хоста — игра заканчивается для всех клиентов', async () => {
    // Подписка на события консоли для всех клиентов
    players.each(({ page, id }) => {
      page.on('console', (msg) => {
        console.log(`[${id}] [${msg.type()}] ${msg.text()}`)
        for (const arg of msg.args()) {
          arg.jsonValue().then((value) => {
            if (typeof value === 'object' && value !== null) {
              console.log(`[${id}]   аргумент:`, JSON.stringify(value))
            }
          })
        }
      })
    })

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
        await pN.goto('/?test', { waitUntil: 'domcontentloaded' }) // Добавляем параметр test
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

    // 2) Определяем кто на самом деле является хостом
    console.log('=== Определяем текущего хоста ===')
    
    let actualHostPage: Page | null = null
    let actualHostId: PlayerId | null = null
    const remainingPlayerIds: PlayerId[] = []
    
    for (const { page, id } of players.clients) {
      const pid = id as PlayerId
      
      try {
        // Проверяем есть ли у этого игрока элемент, который есть только у хоста
        const hostIndicator = await page.locator('.room-id').count()
        if (hostIndicator > 0) {
          console.log(`✅ Игрок ${pid} является хостом`)
          actualHostPage = page
          actualHostId = pid
        } else {
          console.log(`👤 Игрок ${pid} является клиентом`)
          remainingPlayerIds.push(pid)
        }
      } catch (error) {
        console.log(`❌ Ошибка при проверке игрока ${pid}:`, error)
        remainingPlayerIds.push(pid) // Считаем клиентом при ошибке
      }
    }
    
    if (!actualHostPage || !actualHostId) {
      throw new Error('Не удалось определить текущего хоста!')
    }
    
    console.log(`🎯 Текущий хост: ${actualHostId}, клиенты: [${remainingPlayerIds.join(', ')}]`)

    // 3) Хост выходит из лобби
    const leaveRoomButton = actualHostPage.getByTestId('leave-room-button')
    await leaveRoomButton.waitFor({ state: 'visible', timeout: 15000 })
    console.log(`🚪 Хост ${actualHostId} нажимает кнопку выхода`)
    await leaveRoomButton.click()
    await actualHostPage.getByTestId('create-room-button').waitFor({ state: 'visible', timeout: 10000 })

    // 4) Проверяем что все клиенты сразу вернулись на главную страницу 
    // (игра должна закончиться мгновенно из-за добровольного выхода хоста)
    
    console.log('Проверяем что все клиенты мгновенно перешли на главную страницу...')
    
    // Ждем максимум 5 секунд - должно произойти быстро при получении host_left_room сообщения
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))

      let allReturnedHome = true
      for (const pid of remainingPlayerIds) {
        const page = players.get(pid).page
        // Проверяем что на странице есть кнопка создания комнаты (главная страница)
        const createRoomButton = page.getByTestId('create-room-button')
        if (await createRoomButton.count() === 0) {
          allReturnedHome = false
          console.log(`Клиент ${pid} ещё не на главной странице`)
          break
        }
      }

      if (allReturnedHome) {
        console.log('✅ Все клиенты мгновенно вернулись на главную страницу')
        break
      }

      console.log(`Попытка ${attempt + 1}/10: ждем возврата всех клиентов на главную...`)
    }

    // 4) Финальная проверка: убеждаемся что все клиенты на главной странице
    console.log('=== Финальная проверка: все клиенты на главной странице ===')
    
    for (const pid of remainingPlayerIds) {
      const page = players.get(pid).page
      
      // Проверяем наличие кнопки создания комнаты (главная страница)
      await expect(page.getByTestId('create-room-button')).toBeVisible({ timeout: 5000 })
      
      // Проверяем наличие поля ввода никнейма (главная страница)  
      await expect(page.getByTestId('nickname-input')).toBeVisible({ timeout: 5000 })
      
      // Проверяем что НЕТ списка игроков (значит не в лобби)
      expect(await page.locator('[data-testid="players-list"]').count()).toBe(0)
      
      console.log(`✅ Клиент ${pid} вернулся на главную страницу`)
    }

    console.log('✅ Тест завершен успешно: все клиенты вернулись на главную страницу после выхода хоста')
    
    // await host.pause() // Раскомментировать для отладки
  })
})
