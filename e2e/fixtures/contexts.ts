import { Browser, BrowserContext, Page, chromium } from '@playwright/test'

export type PlayerId = `p${number}`
export type AnyPlayerId = PlayerId

export interface PlayerClient {
  id: AnyPlayerId
  browser: Browser // отдельный процесс chromium для каждого игрока
  context: BrowserContext
  page: Page
  snapshot: () => Promise<Record<string, string>>
  restore: (data: Record<string, string>) => Promise<void>
  gotoApp: (path?: string) => Promise<void>
  close: () => Promise<void>
}

export interface MultiClient {
  clients: PlayerClient[]
  each: (fn: (c: PlayerClient, index: number) => Promise<unknown> | unknown) => Promise<void>
  broadcast: (fn: (c: PlayerClient, index: number) => Promise<unknown> | unknown) => Promise<void>
  get: (id: AnyPlayerId) => PlayerClient
  restart: (id: AnyPlayerId) => Promise<PlayerClient>
  closeAll: () => Promise<void>

  // доступ по playerN
  [key: string]: any
}

/**
 * Create an isolated BrowserContext with helpers to manage localStorage.
 * Navigates with ?mockPeer=1 and ?player={id} to enable mocked networking and per-player identity.
 */
export async function createPlayerContext(
  _browser: Browser,
  baseURL: string,
  id: AnyPlayerId,
  screenSize?: { width: number; height: number },
): Promise<PlayerClient> {
  // Размеры окна для каждого игрока
  const width = screenSize?.width || 960
  const height = screenSize?.height || 620
  // Запускаем отдельный процесс Chromium на игрока с нужной позицией и размером окна.
  // Переводим окна на второй монитор: основной 1920x1080 слева, второй справа 2560x1440.
  // Базовая точка второго монитора: X=1920, Y=0. Раскладываем игроков «сеткой».
  const baseLeft = screenSize ? 0 : 1920
  const baseTop = screenSize ? 0 : 0
  const gapX = 0
  const gapY = 120
  const positions: [number, number][] = screenSize
    ? [
        [0, 0],
        [width + gapX, 0],
        [0, height + gapY],
        [width + gapX, height + gapY],
      ]
    : [
        [baseLeft + 0, baseTop + 0],
        [baseLeft + width + gapX, baseTop + 0],
        [baseLeft + 0, baseTop + height + gapY],
        [baseLeft + width + gapX, baseTop + height + gapY],
      ]
  const match = String(id).match(/^p(\d+)$/)
  const idx = (match ? Math.max(1, parseInt(match[1], 10)) : 1) - 1 // 0-based
  const [left, top] = positions[idx] ?? positions[0]

  const playerBrowser = await chromium.launch({
    headless: false,
    // Явно позиционируем каждое окно Chromium на втором мониторе через аргументы
    args: [
      `--window-size=${width},${height}`,
      `--window-position=${left},${top}`,
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  })

  const context = await playerBrowser.newContext({
    storageState: undefined,
    viewport: { width: width, height: height },
  })
  const page = await context.newPage()

  const gotoApp = async (path: string = '/') => {
    const sep = path.includes('?') ? '&' : '?'
    await page.goto(`${baseURL}${path}${sep}mockPeer=1&player=${id}`)
  }

  // Первичная навигация
  await gotoApp('/')

  const snapshot = async () => {
    const data = await page.evaluate(() => {
      const out: Record<string, string> = {}
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (!k) continue
        const v = window.localStorage.getItem(k)
        if (v !== null) out[k] = v
      }
      return out
    })
    return data
  }

  const restore = async (data: Record<string, string>) => {
    await page.evaluate((d) => {
      try {
        window.localStorage.clear()
      } catch {}
      for (const [k, v] of Object.entries(d)) {
        try {
          window.localStorage.setItem(k, v)
        } catch {}
      }
    }, data)
  }

  const close = async () => {
    try {
      await page.close()
    } catch {}
    try {
      await context.close()
    } catch {}
    try {
      await playerBrowser.close()
    } catch {}
  }

  return {
    id,
    browser: playerBrowser,
    context,
    page,
    snapshot,
    restore,
    gotoApp,
    close,
  }
}

/**
 * Factory to create 4 players A..D in one browser.
 */
export async function createPlayers(
  browser: Browser,
  baseURL: string,
  numPlayers: number = 1,
  screenSize?: { width: number; height: number },
): Promise<MultiClient> {
  // Всегда используем числовые id p1..pN
  const ids: AnyPlayerId[] = Array.from(
    { length: Math.max(0, numPlayers) },
    (_, i) => `p${i + 1}` as `p${number}`,
  )
  // Создаём все контексты параллельно, сохраняя порядок p1..pN
  const instances: PlayerClient[] = await Promise.all(
    ids.map((id) => createPlayerContext(browser, baseURL, id, screenSize)),
  )

  // Выполняем операции над игроками параллельно, чтобы ускорить тесты
  const each = async (fn: (c: PlayerClient, index: number) => Promise<unknown> | unknown) => {
    await Promise.all(instances.map((c, i) => Promise.resolve(fn(c, i))))
  }

  const broadcast = async (fn: (c: PlayerClient, index: number) => Promise<unknown> | unknown) => {
    await each(fn)
  }

  const get = (id: AnyPlayerId): PlayerClient => {
    const f = instances.find((c) => c.id === id)
    if (!f) throw new Error(`Player ${id} not found`)
    return f
  }

  const restart = async (id: AnyPlayerId): Promise<PlayerClient> => {
    // snapshot existing storage, close, create new one, restore and navigate
    const current = get(id)
    const snap = await current.snapshot()
    await current.close()
    const fresh = await createPlayerContext(browser, baseURL, id)
    await fresh.restore(snap)
    await fresh.gotoApp('/')
    // replace instance
    const idx = instances.findIndex((c) => c.id === id)
    instances.splice(idx, 1, fresh)
    return fresh
  }

  const closeAll = async () => {
    await Promise.all(instances.map((c) => c.close()))
  }

  const api: MultiClient = {
    clients: instances,
    each,
    broadcast,
    get,
    restart,
    closeAll,
  }

  // Индексируем p1, p2, ... и player1, player2, ... для удобного доступа
  instances.forEach((c, idx) => {
    ;(api as any)[`p${idx + 1}`] = c
    ;(api as any)[`player${idx + 1}`] = c
  })

  return api
}
