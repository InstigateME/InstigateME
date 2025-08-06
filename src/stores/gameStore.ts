import {ref, computed, watch} from 'vue'
import {defineStore} from 'pinia'
import { storageSafe } from '@/utils/storageSafe'
import type {
  Player,
  GameState,
  PeerMessage,
  MigrationProposalPayload,
  MigrationVotePayload,
  MigrationConfirmedPayload,
  NewHostIdPayload,
  HostDiscoveryRequestPayload,
  HostDiscoveryResponsePayload,
  PeerListRequestPayload,
  PeerListUpdatePayload,
  DirectConnectionRequestPayload,
  StateSyncPayload,
  NewHostElectionPayload,
  ExtendedSessionData,
  HostRecoveryAnnouncementPayload
} from '@/types/game'
import { makeMessage } from '@/types/game'
import type { MessageMeta } from '@/types/game'
import {peerService} from '@/services/peerService'
import {
  MIGRATION_TIMEOUT,
  VOTE_TIMEOUT,
  HOST_DISCOVERY_TIMEOUT,
  HOST_GRACE_PERIOD,
  MESH_RESTORATION_DELAY
} from '@/types/game'

/**
 * Персистентность и синхронизация
 * - Pinia persist: атомарные поля (см. persist.paths ниже)
 * - storageSafe (namespace 'game'): TTL-снапшот hostGameStateSnapshot, стабильный roomId
 */
const SESSION_TIMEOUT = 30 * 60 * 1000 // 30 минут
const HOST_SNAPSHOT_TTL = 15 * 60 * 1000 // 15 минут

// ---------- Request guards & standardized errors ----------
type RequestKey = 'createRoom' | 'joinRoom' | 'restoreSession'
type RequestStatus = 'idle' | 'pending' | 'success' | 'error'
type RequestMap = Record<RequestKey, {
  status: RequestStatus
  requestId: number
  error: StandardError | null
}>
interface StandardError {
  code?: string
  message: string
  details?: unknown
  at: number
}

// last-write-wins счетчик
const requestSeq = ref(0)
const requests = ref<RequestMap>({
  createRoom: { status: 'idle', requestId: 0, error: null },
  joinRoom: { status: 'idle', requestId: 0, error: null },
  restoreSession: { status: 'idle', requestId: 0, error: null }
})

function normalizeError(e: unknown, code?: string): StandardError {
  if (e && typeof e === 'object' && 'message' in e) {
    return {
      code,
      message: String((e as any).message ?? 'Unknown error'),
      details: e,
      at: Date.now()
    }
  }
  return {
    code,
    message: typeof e === 'string' ? e : 'Unknown error',
    details: e,
    at: Date.now()
  }
}

function startRequest(key: RequestKey): number {
  const id = ++requestSeq.value
  const entry = requests.value[key]
  entry.status = 'pending'
  entry.requestId = id
  entry.error = null
  return id
}

function endRequestSuccess(key: RequestKey, id: number) {
  const entry = requests.value[key]
  if (entry.requestId !== id) return // устаревший
  entry.status = 'success'
}

function endRequestError(key: RequestKey, id: number, err: StandardError) {
  const entry = requests.value[key]
  if (entry.requestId !== id) return // устаревший
  entry.status = 'error'
  entry.error = err
}

// Удобные computed для UI
const isLoadingCreateRoom = computed(() => requests.value.createRoom.status === 'pending')
const isLoadingJoinRoom = computed(() => requests.value.joinRoom.status === 'pending')
const isLoadingRestore = computed(() => requests.value.restoreSession.status === 'pending')
const lastErrorCreateRoom = computed(() => requests.value.createRoom.error)
const lastErrorJoinRoom = computed(() => requests.value.joinRoom.error)
const lastErrorRestore = computed(() => requests.value.restoreSession.error)

interface SessionData extends ExtendedSessionData {
  // Наследуем все поля от ExtendedSessionData для совместимости
}

export const useGameStore = defineStore('game', () => {
  // ---------- StorageSafe wrappers ----------
  // Очистка namespace 'game'
  const removeGameItemsByPrefix = () => {
    try { storageSafe.clearNamespace('game') } catch {}
  }
  // Никнейм хранится БЕЗ префикса по требованию — предполагаем отдельные хелперы не используются.
  // Сохраняем ник напрямую в non-prefixed ключ (совместимость с требованиями).
  const NICK_STORAGE_KEY = 'nickname'
  const setNickname = (nick: string) => {
    try { localStorage.setItem(NICK_STORAGE_KEY, nick) } catch {}
  }
  const getNickname = (): string | null => {
    try { return localStorage.getItem(NICK_STORAGE_KEY) } catch { return null }
  }
  const clearNickname = () => {
    try { localStorage.removeItem(NICK_STORAGE_KEY) } catch {}
  }

  // Game mechanics for "Провокатор"
  // Структура голосов: { [voterId]: [targetId, targetId] }
  // Структура ставок: { [playerId]: '0' | '±' | '+' }
  // Структура очков: { [playerId]: number }

  // Режим игры: 'basic' — обычный, 'advanced' — 2.0 (с письменными ответами)
  // gameMode хранит текущий активный режим и синхронизируется в gameState для клиентов.
  const gameMode = ref<'basic' | 'advanced'>('basic')
  const gamePhase = ref<'lobby' | 'drawing_question' | 'voting' | 'secret_voting' | 'betting' | 'results' | 'answering' | 'guessing' | 'selecting_winners' | 'advanced_results' | 'game_over'>('lobby')

  // Чередование: 16 раундов, нечетные — basic, четные — advanced
  const TOTAL_ROUNDS = 16
  const currentRound = ref<number>(1)
  const currentMode = computed<'basic' | 'advanced'>(() => (currentRound.value % 2 === 1 ? 'basic' : 'advanced'))
  const roundsLeft = computed<number>(() => Math.max(0, TOTAL_ROUNDS - currentRound.value + 1))

  // Следующий раунд: инкрементируем счетчик до 16 и пересчитываем режим
  const advanceRound = () => {
    if (currentRound.value < TOTAL_ROUNDS) {
      currentRound.value += 1
    }
    // Обновляем режим согласно чередованию и синхронизируем в state
    gameMode.value = currentMode.value
    gameState.value.gameMode = currentMode.value
  }

  const initializeGame = (mode: 'basic' | 'advanced' = 'basic') => {
    gamePhase.value = 'lobby';
    gameMode.value = mode;

    // Явно фиксируем режим/фазу и новые поля и в GameState
    gameState.value.gameMode = mode;
    gameState.value.phase = 'lobby';

    gameState.value.questionCards = Array.from({ length: 20 }, (_, i) => `Вопрос-провокация #${i + 1}`)

    // Инициализация карт и очков
    gameState.value.scores = {}
    gameState.value.players.forEach((player) => {
      player.votingCards = ['Голос 1', 'Голос 2']
      player.bettingCards = ['0', '±', '+']
      gameState.value.scores[player.id] = 0
    })

    // Стартовый ход
    gameState.value.currentTurn = 0
    gameState.value.currentTurnPlayerId = gameState.value.players[0]?.id || null

    // Сброс полей раунда
    gameState.value.currentQuestion = null
    gameState.value.votes = {}
    gameState.value.voteCounts = {}
    gameState.value.bets = {}
    gameState.value.roundScores = {}

    // Для режима 2.0
    if (mode === 'advanced') {
      gameState.value.answers = {}
      gameState.value.guesses = {}
      gameState.value.answeringPlayerId = null
      gameState.value.advancedAnswer = null
    }

    // Стартуем строго с первого раунда и корректного режима по чередованию
    currentRound.value = 1
    gameMode.value = currentMode.value
    gameState.value.gameMode = currentMode.value

    // Переводим в фазу вытягивания вопроса
    gamePhase.value = 'drawing_question'
    gameState.value.phase = 'drawing_question'
  };

  // Обработка голосов и ставок после раунда
  // Подсчёт очков базового режима
  const processRound = () => {
    // Безопасно получаем значения
    const votesObj = gameState.value.votes ?? {}
    const betsObj = gameState.value.bets ?? {}

    // Подсчёт голосов за каждого игрока
    const voteCounts: Record<string, number> = {}
    Object.values(votesObj).forEach((voteArr: string[]) => {
      voteArr.forEach(targetId => {
        if (!voteCounts[targetId]) voteCounts[targetId] = 0
        voteCounts[targetId]++
      })
    })
    gameState.value.voteCounts = voteCounts

    // Определяем максимум голосов
    const maxVotes = Math.max(0, ...Object.values(voteCounts))
    const leaders = Object.entries(voteCounts)
      .filter(([_, count]) => count === maxVotes && maxVotes > 0)
      .map(([playerId]) => playerId)

    // Начисляем очки по правилам
    const roundScores: Record<string, number> = {}
    gameState.value.players.forEach(player => {
      const pid = player.id
      const bet = betsObj[pid]
      const votes = voteCounts[pid] || 0
      let add = 0

      if (leaders.includes(pid) && bet === '+') {
        add = votes
      } else if (votes === 0 && bet === '0') {
        add = 1
      } else if (bet === '±' && votes > 0 && !leaders.includes(pid)) {
        add = 1
      }
      gameState.value.scores[pid] = (gameState.value.scores[pid] || 0) + add
      roundScores[pid] = add
    })
    gameState.value.roundScores = roundScores

    // ВАЖНО: НЕ сбрасываем голоса и ставки здесь.
    // Они нужны для отображения в фазе 'results'.
    // Очистка произойдет в finishRound при переходе к следующему раунду.
  };

    // mode: 'basic' | 'advanced'
  const startGame = (mode: 'basic' | 'advanced' = 'basic') => {
    if (!isHost.value) return
    // Разрешаем старт при >=3 игроках ИЛИ мы находимся в явной фазе лобби
    const enoughPlayers = gameState.value.players.length >= 3
    const isLobby = (gameState.value.phase ?? 'lobby') === 'lobby'
    if (!enoughPlayers && !isLobby) return

    // Инициализируем игру и явно дублируем всё в gameState для клиентов
    // Параметр mode больше НЕ фиксирует режим — режим строго задается чередованием по currentRound.
    initializeGame(mode)
    gameState.value.gameStarted = true
    // Синхронизируем режим строго из currentMode (источник правды — номер раунда)
    gameMode.value = currentMode.value
    gameState.value.gameMode = currentMode.value
    gameState.value.phase = 'drawing_question'

    // Немедленно шлем актуальное состояние всем клиентам
    broadcastGameState()
  }

  // ВАЖНО: drawCard вызывается на стороне хоста (локально у хоста), но инициироваться может клиентом через draw_question_request.
  // Не полагаемся на myPlayerId на хосте, а проверяем requesterId, который передаём из обработчика сообщения.
  const drawCard = (requesterId?: string | null) => {
    // Действие разрешено только в фазе вытягивания вопроса
    if (gamePhase.value !== 'drawing_question') return null

    const currentTurnPid = gameState.value.currentTurnPlayerId
    if (!currentTurnPid) return null

    // Если вызвано локально у хоста (например, сам хост в свой ход), разрешаем.
    // Если вызвано по сети (requesterId передан), проверяем, что именно текущий игрок запросил действие.
    if (requesterId && requesterId !== currentTurnPid) return null

    if (gameState.value.questionCards.length === 0) return null

    // Вытягиваем карту
    const card = gameState.value.questionCards.shift() || null
    gameState.value.currentQuestion = card

    // Сначала рассылаем состояние с установленным вопросом в фазе drawing_question
    gameState.value.phase = 'drawing_question'
    gamePhase.value = 'drawing_question'
    broadcastGameState()

    // После того как вопрос установлен и разослан в фазе drawing_question,
    // сразу переходим к голосованию, чтобы шаблон показывал одновременно карточку и голосование.
    // Карточка вопроса будет отображаться в секции голосования (см. GameField.vue).
    // На всякий случай синхронизируем режим перед выбором следующей фазы
    gameMode.value = currentMode.value
    gameState.value.gameMode = currentMode.value
    const nextPhase = gameMode.value === 'basic' ? 'voting' : 'secret_voting'
    gamePhase.value = nextPhase
    gameState.value.phase = nextPhase
    broadcastGameState()

    return card
  }

  // Игрок делает голос: votesArr — массив из двух id выбранных игроков
  const submitVote = (voterId: string, votesArr: string[]) => {
    if (gamePhase.value !== 'voting' && gamePhase.value !== 'secret_voting') return
    if (!gameState.value.votes) gameState.value.votes = {}
    gameState.value.votes[voterId] = votesArr
    broadcastGameState()
  }

  // Игрок делает ставку: bet — '0' | '±' | '+'
  const submitBet = (playerId: string, bet: '0' | '±' | '+') => {
    if (gamePhase.value !== 'betting') return
    if (!gameState.value.bets) gameState.value.bets = {}

    // Не даем менять ставку после первой фиксации (alreadyBet на клиенте), но защищаем и на хосте
    if (gameState.value.bets[playerId]) return

    // Фиксируем ставку и сразу шлем обновление, чтобы UI в фазе results корректно показывал выбранное значение
    gameState.value.bets[playerId] = bet
    broadcastGameState()

    // Если все активные игроки сделали ставку — сразу считаем и показываем результаты
    const playersCount = gameState.value.players.length
    const betsCount = Object.keys(gameState.value.bets).length

    if (betsCount >= playersCount) {
      processRound()
      gamePhase.value = 'results'
      gameState.value.phase = 'results'
      broadcastGameState()
    }
  }

  // Завершить фазу/раунд локально на стороне хоста (используется из сетевого обработчика)
  const finishRoundHostOnly = () => {
    // Защита от преждевременного перехода из betting в results до получения всех ставок
    if (gameMode.value === 'basic' && gamePhase.value === 'betting') {
      const playersCount = gameState.value.players.length
      const betsCount = Object.keys(gameState.value.bets || {}).length
      if (betsCount < playersCount) {
        console.log('Finish round ignored: not all bets received', { betsCount, playersCount })
        return
      }
    }

    // Управление фазами и очками
    if (gameMode.value === 'basic') {
      // Если только что завершилось голосование — переходим к ставкам
      if (gamePhase.value === 'voting') {
        gamePhase.value = 'betting';
        gameState.value.phase = 'betting';
        broadcastGameState()
        return
      }

      // Если завершены ставки — считаем очки и показываем результаты
      if (gamePhase.value === 'betting') {
        processRound()
        gamePhase.value = 'results'
        gameState.value.phase = 'results'
        broadcastGameState()
        return
      }

      // Если показаны результаты — готовим следующий раунд
      if (gamePhase.value === 'results') {
        // Переход хода
        const nextTurn = ((gameState.value.currentTurn || 0) + 1) % (gameState.value.players.length || 1)
        gameState.value.currentTurn = nextTurn
        gameState.value.currentTurnPlayerId = gameState.value.players[nextTurn]?.id || null

        // Инкремент номера раунда и переключение режима по чередованию basic/advanced
        advanceRound()

        // Сброс раундовых данных
        gameState.value.currentQuestion = null
        gameState.value.votes = {}
        gameState.value.voteCounts = {}
        gameState.value.bets = {}
        gameState.value.roundScores = {}

        // Проверка на конец игры
        // Проверка на конец игры по лимиту раундов или отсутствию карт
        if (currentRound.value > TOTAL_ROUNDS || gameState.value.questionCards.length === 0) {
          gamePhase.value = 'game_over'
          gameState.value.phase = 'game_over'
        } else {
          gamePhase.value = 'drawing_question'
          gameState.value.phase = 'drawing_question'
        }

        // Обновляем карты на руках (если нужно)
        gameState.value.players.forEach((player) => {
          player.votingCards = ['Голос 1', 'Голос 2']
          player.bettingCards = ['0', '±', '+']
        })

        broadcastGameState()
        return
      }
    } else {
      // advanced режим
      if (gamePhase.value === 'secret_voting') {
        // Определяем отвечающего по голосам
        const votesObj = gameState.value.votes ?? {}
        const voteCounts: Record<string, number> = {}
        Object.values(votesObj).forEach((voteArr: string[]) => {
          voteArr.forEach((targetId) => {
            voteCounts[targetId] = (voteCounts[targetId] || 0) + 1
          })
        })
        gameState.value.voteCounts = voteCounts

        const maxVotes = Math.max(0, ...Object.values(voteCounts))
        const leaders = Object.entries(voteCounts)
          .filter(([_, count]) => count === maxVotes && maxVotes > 0)
          .map(([playerId]) => playerId)

        gameState.value.answeringPlayerId = leaders[0] || null
        gamePhase.value = 'answering'
        gameState.value.phase = 'answering'
        broadcastGameState()
        return
      }

      if (gamePhase.value === 'answering') {
        // Получили ответ — переходим к угадыванию
        gamePhase.value = 'guessing'
        gameState.value.phase = 'guessing'
        broadcastGameState()
        return
      }

      if (gamePhase.value === 'guessing') {
        // После получения всех догадок переходим к фазе выбора победителей автором правильного ответа
        // Выбирает игрок, писавший правильный ответ (answeringPlayerId).
        gamePhase.value = 'selecting_winners'
        gameState.value.phase = 'selecting_winners'
        // Инициализируем контейнер для выбранных победителей этого раунда
        if (!gameState.value.roundWinners) gameState.value.roundWinners = []
        broadcastGameState()
        return
      }

      if (gamePhase.value === 'advanced_results') {
        // Переход хода и сброс
        const nextTurn = ((gameState.value.currentTurn || 0) + 1) % (gameState.value.players.length || 1)
        gameState.value.currentTurn = nextTurn
        gameState.value.currentTurnPlayerId = gameState.value.players[nextTurn]?.id || null

        // Инкремент номера раунда и переключение режима по чередованию basic/advanced
        advanceRound()

        gameState.value.currentQuestion = null
        gameState.value.votes = {}
        gameState.value.voteCounts = {}
        gameState.value.guesses = {}
        ;(gameState.value as any).roundWinners = []
        gameState.value.answers = {}
        gameState.value.answeringPlayerId = null
        gameState.value.advancedAnswer = null
        gameState.value.roundScores = {}

        // Завершаем игру по лимиту раундов или когда закончились карты
        if (currentRound.value > TOTAL_ROUNDS || gameState.value.questionCards.length === 0) {
          gamePhase.value = 'game_over'
          gameState.value.phase = 'game_over'
        } else {
          gamePhase.value = 'drawing_question'
          gameState.value.phase = 'drawing_question'
        }
        broadcastGameState()
        return
      }
    }
  };
  // Состояние игры
  const gameState = ref<GameState & {
    currentQuestion?: string | null,
    votes?: Record<string, string[]>,
    bets?: Record<string, string>
  }>({
    roomId: '',
    gameStarted: false,
    players: [],
    litUpPlayerId: null,
    maxPlayers: 8,
    hostId: '',
    createdAt: 0,
    questionCards: Array.from({length: 20}, (_, i) => `Вопрос-провокация #${i + 1}`),
    votingCards: {},
    bettingCards: {},
    currentTurn: 0,
    scores: {},
    currentQuestion: null,
    votes: {},
    bets: {}
  });

  // Локальные данные
  const myPlayerId = ref<string>('')

  // ===== Versioned sync client state (backward-compatible) =====
  const currentVersion = ref<number>(0)
  const initReceived = ref<boolean>(false)
  const lastServerTime = ref<number>(0)
  const pendingDiffs = ref<Map<number, any>>(new Map())

  // Fallback ожидания первичного снапшота и легаси-инициализации
  const SNAPSHOT_TIMEOUT_MS = 2500
  let _snapshotTimeoutHandle: number | null = null
  const _acceptLegacyAsInit = ref<boolean>(false)

  // --- Helpers for versioned sync ---
  function deepMerge(target: any, patch: any) {
    if (patch === null) {
      return null
    }
    if (Array.isArray(patch)) {
      // массивы заменяем целиком
      return patch.slice()
    }
    if (typeof patch !== 'object' || patch === null) {
      return patch
    }
    if (typeof target !== 'object' || target === null) {
      target = {}
    }
    const result: any = Array.isArray(target) ? target.slice() : { ...target }
    for (const key of Object.keys(patch)) {
      const val = (patch as any)[key]
      if (val === null) {
        // null => delete key
        if (Array.isArray(result)) {
          // непредусмотрено для массивов — пропускаем
        } else {
          delete result[key]
        }
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        result[key] = deepMerge(result[key], val)
      } else {
        result[key] = Array.isArray(val) ? val.slice() : val
      }
    }
    return result
  }

  function applyDiff(patch: any) {
    if (patch === null || patch === undefined) return
    const next = deepMerge(gameState.value, patch)
    if (next !== null) {
      gameState.value = next as any
    }
  }

  function drainPending() {
    let nextVer = (currentVersion.value || 0) + 1
    while (pendingDiffs.value.has(nextVer)) {
      const payload = pendingDiffs.value.get(nextVer)
      pendingDiffs.value.delete(nextVer)
      try {
        applyDiff(payload?.patch)
        currentVersion.value = nextVer
        lastServerTime.value = Math.max(lastServerTime.value, payload?.meta?.serverTime || 0)
        nextVer++
      } catch (e) {
        console.warn('Failed to apply buffered diff', e)
        break
      }
    }
  }

  function sendAck(version: number) {
    try {
      peerService.broadcastMessage(
        makeMessage(
          'state_ack' as any,
          { roomId: roomId.value || gameState.value.roomId, version, receivedAt: Date.now() } as any,
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    } catch {}
  }

  function requestResync(fromVersion?: number) {
    try {
      peerService.broadcastMessage(
        makeMessage(
          'resync_request' as any,
          { roomId: roomId.value || gameState.value.roomId, fromVersion, reason: initReceived.value ? 'gap' : 'init_missing' } as any,
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    } catch {}
  }
  const myNickname = ref<string>('')
  const isHost = ref<boolean>(false)
  const hostId = ref<string>('')
  const roomId = ref<string>('')
  const connectionStatus = ref<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const restorationState = ref<'idle' | 'discovering' | 'restoring'>('idle')
  // Метка последней успешной сессии/подключения
  const sessionTimestamp = ref<number | null>(null)

  // Computed
  // Кнопка "Начать" должна быть активна для хоста при >=3 игроках и если игра еще не запущена
  // Также учитываем восстановление состояния: если мы хост и phase === 'lobby', разрешаем старт независимо от gameStarted флага,
  // так как он может быть не синхронизирован в начальный момент.
  const canStartGame = computed(() => {
    const enoughPlayers = gameState.value.players.length >= 3
    const isLobby = (gameState.value.phase ?? 'lobby') === 'lobby'
    const notStarted = !gameState.value.gameStarted
    return isHost.value && enoughPlayers && (notStarted || isLobby)
  })

  const myPlayer = computed(() =>
    gameState.value.players.find(p => p.id === myPlayerId.value)
  )

  const canJoinRoom = computed(() =>
    gameState.value.players.length < gameState.value.maxPlayers || !gameState.value.gameStarted
  )

  // Предустановленная палитра из 8 контрастных цветов (WCAG-friendly)
  const PLAYER_COLORS: string[] = [
    '#FF6B6B', // Red
    '#4ECDC4', // Teal
    '#45B7D1', // Blue
    '#C7F464', // Lime
    '#FFA500', // Orange
    '#AA66CC', // Purple
    '#FFD93D', // Yellow
    '#2ECC71'  // Green
  ]

  // Определение цвета по индексy присоединения (детерминированно, циклически)
  const getColorByIndex = (index: number): string => {
    return PLAYER_COLORS[index % PLAYER_COLORS.length]
  }

  // Генерация никнейма по умолчанию
  const NICKNAME_PREFIX = 'Player'

  const generateDefaultNickname = (): string => {
    return `${NICKNAME_PREFIX}${Math.floor(Math.random() * 9999)}`
  }

  // Генерация читаемого ID комнаты
  const generateRoomId = (): string => {
    const adjectives = ['RED', 'BLUE', 'GREEN', 'GOLD', 'SILVER', 'PURPLE', 'ORANGE', 'PINK']
    const nouns = ['DRAGON', 'TIGER', 'EAGLE', 'WOLF', 'LION', 'BEAR', 'SHARK', 'PHOENIX']
    const numbers = Math.floor(Math.random() * 100)

    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)]
    const noun = nouns[Math.floor(Math.random() * nouns.length)]

    return `${adjective}-${noun}-${numbers}`
  }

  // Устойчивое хранение roomId между перезагрузками хоста (storageSafe, namespace 'game')
  const savePersistentRoomId = (rid: string) => {
    try { storageSafe.nsSet('game', 'roomIdStable', rid) } catch {}
  }
  const loadPersistentRoomId = (): string | null => {
    try { return storageSafe.nsGet<string>('game', 'roomIdStable') } catch { return null }
  }
  const clearPersistentRoomId = () => {
    try { storageSafe.nsRemove('game', 'roomIdStable') } catch {}
  }

  // Устойчивый идентификатор игрока для переподключений (не равен текущему peer id, это «якорь» прошлой сессии)
  const saveStablePlayerId = (pid: string) => {
    try { storageSafe.nsSet('game', 'playerIdStable', pid) } catch {}
  }
  const loadStablePlayerId = (): string | null => {
    try { return storageSafe.nsGet<string>('game', 'playerIdStable') } catch { return null }
  }
  const clearStablePlayerId = () => {
    try { storageSafe.nsRemove('game', 'playerIdStable') } catch {}
  }

  // Генерация токена безопасности
  const generateAuthToken = (playerId: string, roomId: string, timestamp: number): string => {
    const data = `${playerId}-${roomId}-${timestamp}-${Math.random()}`
    // Простая хеш-функция для создания токена
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Преобразование в 32-битное число
    }
    return Math.abs(hash).toString(36)
  }

  // Проверка валидности токена
  const validateAuthToken = (player: Player): boolean => {
    // Простая проверка наличия токена и его формата
    return !!(player.authToken && player.authToken.length > 0)
  }

  // Создание комнаты (хост)
  const createRoom = async (nickname: string) => {
    const ridGuard = startRequest('createRoom')
    try {
      connectionStatus.value = 'connecting'

      // Перед созданием комнаты: очистить все старые игровые записи
      removeGameItemsByPrefix()
      // Ник сохраняем без префикса
      setNickname(nickname)

      // КРИТИЧНО: Всегда пытаемся восстановить хоста с существующим ID
      const existingSession = loadSession()
      let restoredPeerId: string
      let targetRoomId: string

      if (existingSession && existingSession.isHost) {
        console.log('🔄 MANDATORY: Restoring host session for room:', existingSession.roomId)
        // Пытаемся взять roomId из стабильного хранилища (источник правды)
        targetRoomId = loadPersistentRoomId() || existingSession.roomId

        // ОБЯЗАТЕЛЬНО передаем roomId для восстановления peer ID из localStorage
        restoredPeerId = await peerService.createHost(targetRoomId)

        console.log('📋 Restoring complete game state from saved session')
        myPlayerId.value = restoredPeerId
        myNickname.value = nickname
        isHost.value = true
        roomId.value = targetRoomId
        hostId.value = restoredPeerId
        gameState.value = {...existingSession.gameState}
        gameState.value.hostId = restoredPeerId

        // Обновляем мой ID в списке игроков
        const myPlayerIndex = gameState.value.players.findIndex((p: Player) => p.isHost)
        if (myPlayerIndex !== -1) {
          gameState.value.players[myPlayerIndex].id = restoredPeerId
          gameState.value.players[myPlayerIndex].nickname = nickname
        }

        connectionStatus.value = 'connected'
        peerService.setRoomContext(targetRoomId || gameState.value.roomId || null as any)
      peerService.setAsHost(restoredPeerId, targetRoomId || gameState.value.roomId)
        setupHostMessageHandlers()

        console.log('🎉 Host fully restored with session data - ID:', restoredPeerId)
        return restoredPeerId

      } else {
        // Создание полностью новой комнаты
        console.log('🆕 Creating brand new room')
        // Если ранее уже создавался roomId в этой вкладке — повторно используем
        targetRoomId = loadPersistentRoomId() || generateRoomId()
        // Сохраняем для будущих рестартов вкладки хоста
        savePersistentRoomId(targetRoomId)

        // Передаем roomId даже для новой комнаты, чтобы сохранить peer ID
        restoredPeerId = await peerService.createHost(targetRoomId)
      }

      // Инициализация состояния для новой комнаты
      if (!existingSession || !existingSession.isHost) {
        console.log('🆕 Initializing new room state')
        const now = Date.now()

        myPlayerId.value = restoredPeerId
        myNickname.value = nickname
        isHost.value = true
        roomId.value = targetRoomId
        hostId.value = restoredPeerId

    gameState.value = {
      roomId: targetRoomId,
      gameStarted: false,
      players: [],
      litUpPlayerId: null,
      maxPlayers: 8,
      hostId: restoredPeerId,
      createdAt: now,
      questionCards: [],
      votingCards: {},
      bettingCards: {},
      currentTurn: 0,
      scores: {},
      currentQuestion: null,
      votes: {},
      bets: {},
      answers: {},
      guesses: {}
    }

        // Добавляем хоста в список игроков
          const hostPlayer: Player = {
            id: restoredPeerId,
            nickname,
            color: getColorByIndex(0),
            isHost: true,
            joinedAt: now,
            authToken: generateAuthToken(restoredPeerId, targetRoomId, now),
            votingCards: ['Голос 1', 'Голос 2'],
            bettingCards: ['0', '±', '+']
          }

        gameState.value.players = [hostPlayer]
      }

      connectionStatus.value = 'connected'
      // Синхронизируем устойчивый roomId
      if (roomId.value) savePersistentRoomId(roomId.value)

      // Устанавливаем роль хоста и запускаем heartbeat
      peerService.setRoomContext(targetRoomId || gameState.value.roomId || null as any)
      peerService.setAsHost(restoredPeerId, targetRoomId || gameState.value.roomId)
      setupHostMessageHandlers()
      // Сохраняем roomId для последующих перезагрузок
      savePersistentRoomId(targetRoomId)

      // Сохранение атомарных полей выполняет Pinia persist; устойчивый roomId уже сохранен
      try {} catch {}

      console.log('🏁 Host initialization completed with ID:', restoredPeerId)
      sessionTimestamp.value = Date.now()
      endRequestSuccess('createRoom', ridGuard)
      return restoredPeerId

    } catch (error) {
      connectionStatus.value = 'disconnected'
      endRequestError('createRoom', ridGuard, normalizeError(error, 'create_room_failed'))
      throw error
    }
  }

  // Подключение к комнате (клиент)
  const joinRoom = async (nickname: string, targetHostId: string) => {
    const ridGuard = startRequest('joinRoom')
    try {
      connectionStatus.value = 'connecting'

      // Перед входом в комнату: очистить все старые игровые записи
      removeGameItemsByPrefix()
      // Ник сохраняем без префикса
      setNickname(nickname)

      // 1) Подключаемся к хосту
      await peerService.connectToHost(targetHostId)

      // 2) Инициализируем локальные поля
      myNickname.value = nickname
      hostId.value = targetHostId
      myPlayerId.value = peerService.getMyId() || ''
      // Сохраняем устойчивый playerId для последующих переподключений
      if (myPlayerId.value) saveStablePlayerId(myPlayerId.value)

      // 3) Устанавливаем роль клиента и СРАЗУ вешаем обработчики,
      //    чтобы не потерять первое game_state_update от хоста
      peerService.setAsClient()
      setupClientMessageHandlers()

      // 4) Отправляем join_request (с сохраненным устойчивым ID для ремапа)
      const stableId = loadStablePlayerId() || myPlayerId.value
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'join_request',
          {
            nickname,
            savedPlayerId: stableId
          },
          { roomId: roomId.value || gameState.value.roomId || '', fromId: myPlayerId.value, ts: Date.now() } as MessageMeta
        )
      )

      // 5) Идемпотентный запрос актуального состояния, чтобы гарантированно получить список игроков
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          { roomId: roomId.value || gameState.value.roomId || '', fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      // 6) Запрашиваем peer‑лист для mesh
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'request_peer_list',
          {
            requesterId: myPlayerId.value,
            requesterToken: '',
            timestamp: Date.now()
          },
          { roomId: roomId.value || gameState.value.roomId || '', fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      // 7) Дожидаемся быстрого обновления состояния (используем уже существующую утилиту)
      try {
        await waitForGameStateUpdate()
      } catch {}

      // 8) Теперь считаем соединение установленным
      connectionStatus.value = 'connected'

      // Сохранение атомарных полей выполняет Pinia persist
      try {} catch {}
    } catch (error) {
      connectionStatus.value = 'disconnected'
      endRequestError('joinRoom', ridGuard, normalizeError(error, 'join_room_failed'))
      throw error
    }
    // success branch
    sessionTimestamp.value = Date.now()
    endRequestSuccess('joinRoom', ridGuard)
  }

  // Настройка обработчиков сообщений для хоста
  const setupHostMessageHandlers = () => {
    console.log('Setting up host message handlers')

    // КРИТИЧНО: Очищаем старые обработчики перед настройкой новых
    peerService.clearMessageHandlers()
    console.log('Cleared old message handlers before setting up host handlers')

    // Восстановительный канал: клиенты присылают пульс хоста
    peerService.onMessage('heartbeat', (message) => {
      // Хост получает heartbeat только от самого себя в здоровом состоянии.
      // Если мы хост и получаем чужой heartbeat — вероятно, появился другой претендент, игнорируем.
      const payload = (message as any).payload || {}
      const from = (message as any).meta?.fromId
      if (from && from !== myPlayerId.value) {
        console.log('Ignoring foreign heartbeat on host side from:', from)
        return
      }
      // Можно обновлять локальные метки времени, но для хоста это не критично.
    })

    // Обработчик явного выхода игрока: user_left_room
    peerService.onMessage('user_left_room', (message, conn) => {
      if (!isHost.value) return
      const typed = message as Extract<PeerMessage, { type: 'user_left_room' }>
      const { userId, roomId: rid, timestamp, currentScore, reason } = typed.payload

      // Валидация комнаты
      if (rid && gameState.value.roomId && rid !== gameState.value.roomId) {
        console.log('❌ Ignoring user_left_room for different room', { rid, current: gameState.value.roomId })
        return
      }

      // Игрок должен существовать
      const leavingPlayer = gameState.value.players.find((p: Player) => p.id === userId)
      if (!leavingPlayer) {
        console.log('❌ Ignoring user_left_room - player not found:', userId)
        return
      }

      // Инициализация контейнеров присутствия при необходимости
      if (!gameState.value.presence) gameState.value.presence = {}
      if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}

      // Идемпотентность по времени
      const prevMeta = gameState.value.presenceMeta[userId]
      const prevLeftAt = prevMeta?.leftAt || 0
      const ts = timestamp || Date.now()
      if (gameState.value.presence[userId] === 'absent' && prevLeftAt >= ts) {
        console.log('ℹ️ Duplicate/older user_left_room ignored for', userId)
        return
      }

      // Обновляем счет, если передан (не сбрасываем очки)
      if (typeof currentScore === 'number') {
        gameState.value.scores[userId] = currentScore
      } else if (gameState.value.scores[userId] === undefined) {
        gameState.value.scores[userId] = 0
      }

      // Помечаем отсутствие и метаданные
      gameState.value.presence[userId] = 'absent'
      gameState.value.presenceMeta[userId] = {
        lastSeen: Math.max(prevMeta?.lastSeen || 0, ts),
        leftAt: ts,
        reason: reason || 'explicit_leave'
      }

      // Удаляем игрока из списка игроков комнаты (отражается в "Игроки в комнате")
      // Идемпотентно чистим связанные структуры состояния
      try {
        // Удаляем из players
        gameState.value.players = gameState.value.players.filter((p: Player) => p.id !== userId)

        // Очищаем голосование/ставки/догадки
        if (gameState.value.votes) {
          const nv: Record<string, string[]> = {}
          Object.entries(gameState.value.votes).forEach(([k, v]) => {
            if (k !== userId) {
              nv[k] = (v || []).filter(t => t !== userId)
            }
          })
          gameState.value.votes = nv
        }
        if (gameState.value.voteCounts) {
          const nc: Record<string, number> = {}
          Object.entries(gameState.value.voteCounts).forEach(([k, v]) => {
            if (k !== userId) nc[k] = v
          })
          gameState.value.voteCounts = nc
        }
        if (gameState.value.bets) {
          const nb: Record<string, '0' | '±' | '+'> = {}
          Object.entries(gameState.value.bets).forEach(([k, v]) => {
            if (k !== userId) nb[k] = v as any
          })
          gameState.value.bets = nb
        }
        if (gameState.value.guesses) {
          const ng: Record<string, string> = {}
          Object.entries(gameState.value.guesses).forEach(([k, v]) => {
            if (k !== userId) {
              const mappedVal = v === userId ? '' : v
              if (mappedVal) ng[k] = mappedVal
            }
          })
          gameState.value.guesses = ng
        }
        if (gameState.value.roundScores) {
          const nr: Record<string, number> = {}
          Object.entries(gameState.value.roundScores).forEach(([k, v]) => {
            if (k !== userId) nr[k] = v
          })
          gameState.value.roundScores = nr
        }
        // Очистка вспомогательных ссылок
        if (gameState.value.litUpPlayerId === userId) {
          gameState.value.litUpPlayerId = null
        }
        if (gameState.value.currentTurnPlayerId === userId) {
          // Сдвигаем ход на следующего по кругу, если кто-то остался
          const players = gameState.value.players
          if (players.length > 0) {
            const nextIndex = gameState.value.currentTurn ? gameState.value.currentTurn % players.length : 0
            gameState.value.currentTurn = nextIndex
            gameState.value.currentTurnPlayerId = players[nextIndex]?.id || null
          } else {
            gameState.value.currentTurn = 0
            gameState.value.currentTurnPlayerId = null
          }
        }
      } catch (e) {
        console.warn('Failed to cleanup state for leaving player', e)
      }

      // Рассылаем broadcast об уходе (для ARIA/тостов на клиентах)
      peerService.broadcastMessage(
        makeMessage(
          'user_left_broadcast',
          {
            userId,
            roomId: gameState.value.roomId,
            timestamp: Date.now(),
            reason: reason || 'explicit_leave'
          },
          { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() }
        )
      )

      // Обновляем основное состояние игры для всех
      broadcastGameState()
    })

    peerService.onMessage('join_request', (message, conn) => {
      console.log('Host received join_request:', {
        payload: message.payload,
        connPeer: conn?.peer,
        canJoinRoom: canJoinRoom.value,
        currentPlayers: gameState.value.players.length,
        maxPlayers: gameState.value.maxPlayers,
        gameStarted: gameState.value.gameStarted
      })

      if (!conn) {
        console.log('No connection provided to join_request')
        return
      }

      if (!canJoinRoom.value) {
        console.log('Cannot join room:', {
          currentPlayers: gameState.value.players.length,
          maxPlayers: gameState.value.maxPlayers,
          gameStarted: gameState.value.gameStarted
        })
        return
      }

      const { nickname } = (message as Extract<PeerMessage, { type: 'join_request' }>).payload

      // Сначала проверяем, не подключен ли уже этот игрок по ID
      const existingPlayerById = gameState.value.players.find(p => p.id === conn.peer)
      if (existingPlayerById) {
        console.log('Player already exists by ID, updating info:', conn.peer)
        existingPlayerById.nickname = nickname
        broadcastGameState()
        return
      }

      // Проверяем, есть ли игрок с сохраненным ID (переподключение)
      // Используем savedPlayerId из payload сообщения клиента
      const { savedPlayerId } = (message as Extract<PeerMessage, { type: 'join_request' }>).payload
      console.log('🔍 HOST: Checking for existing player by savedPlayerId:', {
        savedPlayerId,
        hasPayloadSavedId: !!savedPlayerId,
        currentPlayers: gameState.value.players.map((p: Player) => ({id: p.id, nickname: p.nickname, isHost: p.isHost})),
        currentLitUpPlayerId: gameState.value.litUpPlayerId
      })

      if (savedPlayerId) {
        // Если это переподключение клиента в период восстановления хоста:
        // 1) Если savedPlayerId равен текущему hostId — это старый ID хоста, который перезагружается.
        //    В этом случае НЕ следует создавать нового игрока и НЕ следует ремапить хоста в клиента.
        //    Клиент должен подождать новой информации о хосте (host_recovery_announcement/new_host_id).
        if (savedPlayerId === gameState.value.hostId) {
          console.log('🛑 Saved ID belongs to current host. Rejecting join to avoid host demotion:', {
            savedPlayerId,
            currentHostId: gameState.value.hostId,
            requester: conn.peer
          })
          // Отвечаем отказом в легкой форме: отправим краткий state, где hostId === savedPlayerId,
          // чтобы клиент мог инициировать восстановление/ожидание.
          try {
            const minimalState = { hostId: gameState.value.hostId, roomId: gameState.value.roomId, players: gameState.value.players }
            peerService.sendMessage(
              conn.peer,
              makeMessage(
                'game_state_update',
                minimalState as any,
                { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() }
              )
            )
          } catch {}
          return
        }

        const existingPlayerBySavedId = gameState.value.players.find(p => p.id === savedPlayerId && !p.isHost)
        console.log('🔍 HOST: Search result for existing player:', {
          existingPlayerFound: !!existingPlayerBySavedId,
          existingPlayer: existingPlayerBySavedId ? {
            id: existingPlayerBySavedId.id,
            nickname: existingPlayerBySavedId.nickname
          } : null
        })

      if (existingPlayerBySavedId) {
        console.log('✅ HOST: Found existing player by saved ID, updating connection:', {
          savedId: savedPlayerId,
          newConnectionId: conn.peer,
          nickname: nickname
        })

        // Полный ремап ID savedPlayerId -> conn.peer во всех полях состояния
        const oldId = savedPlayerId
        const newId = conn.peer

        // 1) litUpPlayerId
        if (gameState.value.litUpPlayerId === oldId) {
          console.log('🔄 HOST: Updating litUpPlayerId from old ID to new ID:', { oldId, newId })
          gameState.value.litUpPlayerId = newId
        }

        // 2) currentTurnPlayerId
        if (gameState.value.currentTurnPlayerId === oldId) {
          console.log('🔄 HOST: Updating currentTurnPlayerId from old ID to new ID:', { oldId, newId })
          gameState.value.currentTurnPlayerId = newId
        }

        // 3) votes (ключи)
        if (gameState.value.votes) {
          const newVotes: Record<string, string[]> = {}
          Object.entries(gameState.value.votes).forEach(([k, v]) => {
            const mappedKey = k === oldId ? newId : k
            // также заменим внутри массивов целевые ID, если кто-то голосовал за oldId
            const mappedArray = (v || []).map(t => (t === oldId ? newId : t))
            newVotes[mappedKey] = mappedArray
          })
          gameState.value.votes = newVotes
        }

        // 4) voteCounts (ключи)
        if (gameState.value.voteCounts) {
          const newCounts: Record<string, number> = {}
          Object.entries(gameState.value.voteCounts).forEach(([k, v]) => {
            const mappedKey = k === oldId ? newId : k
            newCounts[mappedKey] = v
          })
          gameState.value.voteCounts = newCounts
        }

        // 5) bets (ключи)
        if (gameState.value.bets) {
          const newBets: Record<string, '0' | '±' | '+'> = {}
          Object.entries(gameState.value.bets).forEach(([k, v]) => {
            const mappedKey = k === oldId ? newId : k
            newBets[mappedKey] = v
          })
          gameState.value.bets = newBets
        }

        // 6) guesses (ключи и значения-цели)
        if (gameState.value.guesses) {
          const newGuesses: Record<string, string> = {}
          Object.entries(gameState.value.guesses).forEach(([k, v]) => {
            const mappedKey = k === oldId ? newId : k
            const mappedVal = v === oldId ? newId : v
            newGuesses[mappedKey] = mappedVal
          })
          gameState.value.guesses = newGuesses
        }

        // 7) scores / roundScores (ключи)
        if (gameState.value.scores) {
          const newScores: Record<string, number> = {}
          Object.entries(gameState.value.scores).forEach(([k, v]) => {
            const mappedKey = k === oldId ? newId : k
            newScores[mappedKey] = v
          })
          gameState.value.scores = newScores
        }
        if (gameState.value.roundScores) {
          const newRoundScores: Record<string, number> = {}
          Object.entries(gameState.value.roundScores).forEach(([k, v]) => {
            const mappedKey = k === oldId ? newId : k
            newRoundScores[mappedKey] = v
          })
          gameState.value.roundScores = newRoundScores
        }

        // 8) roundWinners (массив ID)
        if (Array.isArray(gameState.value.roundWinners) && gameState.value.roundWinners.length > 0) {
          gameState.value.roundWinners = gameState.value.roundWinners.map(pid => (pid === oldId ? newId : pid))
        }

        // 9) answeringPlayerId
        if (gameState.value.answeringPlayerId === oldId) {
          gameState.value.answeringPlayerId = newId
        }

        // Обновляем ID и токен игрока в players
        existingPlayerBySavedId.id = newId
        existingPlayerBySavedId.nickname = nickname
        existingPlayerBySavedId.authToken = generateAuthToken(newId, gameState.value.roomId, Date.now())

        console.log('🎯 HOST: Broadcasting updated game state with full ID remap:', {
          updatedPlayer: { id: existingPlayerBySavedId.id, nickname: existingPlayerBySavedId.nickname },
          newLitUpPlayerId: gameState.value.litUpPlayerId,
          newCurrentTurnPlayerId: gameState.value.currentTurnPlayerId,
          totalPlayers: gameState.value.players.length
        })

        // Presence: помечаем игрока как present при успешном ремапе
        const nowTs = Date.now()
        if (!gameState.value.presence) gameState.value.presence = {}
        if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
        gameState.value.presence[newId] = 'present'
        gameState.value.presenceMeta[newId] = {
          lastSeen: Math.max(nowTs, gameState.value.presenceMeta[newId]?.lastSeen || 0)
        }
        // Чистим возможные старые метки отсутствия
        delete (gameState.value.presenceMeta[newId] as any).leftAt
        delete (gameState.value.presenceMeta[newId] as any).reason

        // Broadcast о присоединении (для ARIA/тостов)
        peerService.broadcastMessage(
          makeMessage(
            'user_joined_broadcast',
            { userId: newId, roomId: gameState.value.roomId, timestamp: nowTs },
            { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: nowTs }
          )
        )

        broadcastGameState()

        // КРИТИЧНО: Отправляем специальное сообщение клиенту о смене его ID
        peerService.sendMessage(
          newId,
          makeMessage(
            'player_id_updated',
            {
              oldId,
              newId,
              message: 'Your player ID has been updated due to reconnection'
            },
            { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() }
          )
        )

        console.log('✅ HOST: Updated existing player and sent ID update notification:', existingPlayerBySavedId)
        return
      } else {
        console.log('❌ HOST: No existing player found with savedPlayerId, will create new player')
      }
      } else {
        console.log('❌ HOST: No savedPlayerId provided in join_request')
      }

      // Создаем нового игрока только если такого никнейма нет
      const now = Date.now()
      const newPlayerIndex = gameState.value.players.length // индекс нового игрока в текущем составе
      const newPlayer: Player = {
        id: conn.peer,
        nickname,
        color: getColorByIndex(newPlayerIndex),
        isHost: false,
        joinedAt: now,
        authToken: generateAuthToken(conn.peer, gameState.value.roomId, now),
        votingCards: ['Карточка 1', 'Карточка 2'],
        bettingCards: ['0', '±', '+']
      }

      console.log('Adding new player:', newPlayer)
      gameState.value.players.push(newPlayer)

      // Presence: инициализация как present для нового игрока
      if (!gameState.value.presence) gameState.value.presence = {}
      if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
      gameState.value.presence[newPlayer.id] = 'present'
      gameState.value.presenceMeta[newPlayer.id] = { lastSeen: now }

      // Перед любыми рассылками синхронизируем phase/gameMode в state
      gameState.value.phase = gamePhase.value
      gameMode.value = currentMode.value
      gameState.value.gameMode = currentMode.value

      // Unicast: сразу отправляем присоединившемуся игроку актуальный снапшот (гарантированный первичный снимок)
      try {
        const snapshot = { ...gameState.value }
        peerService.sendMessage(
          conn.peer,
          makeMessage(
            'game_state_update',
            snapshot,
            { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() }
          )
        )
      } catch (e) {
        console.warn('Failed to unicast initial snapshot to new player', { peer: conn.peer, error: e })
      }

      // Broadcast о присоединении (для ARIA/тостов у всех)
      peerService.broadcastMessage(
        makeMessage(
          'user_joined_broadcast',
          { userId: newPlayer.id, roomId: gameState.value.roomId, timestamp: now },
          { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: now }
        )
      )

      // Отправляем обновленное состояние всем игрокам
      broadcastGameState()
      console.log('Updated players list:', gameState.value.players.map((p: Player) => ({id: p.id, nickname: p.nickname})))

      // Новая авторитетная логика: сразу после join отправим join_ok и snapshot (unicast), сохраняя обратную совместимость
      try {
        peerService.sendMessage(
          conn.peer,
          makeMessage(
            'join_ok',
            {
              roomId: gameState.value.roomId,
              hostId: gameState.value.hostId,
              serverTime: Date.now(),
              latestVersion: (currentVersion?.value ?? 0)
            } as any,
            { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() }
          )
        )

        // Авторитетный версионный снапшот сразу после join_ok (unicast)
        try {
          const nowTs = Date.now()
          peerService.sendMessage(
            conn.peer,
            makeMessage(
              'state_snapshot' as any,
              {
                meta: {
                  roomId: gameState.value.roomId,
                  version: currentVersion.value || 0,
                  serverTime: nowTs
                },
                state: { ...gameState.value }
              } as any,
              { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: nowTs }
            )
          )
        } catch (e) {
          console.warn('Failed to send authoritative state_snapshot to new player', e)
        }
      } catch (e) {
        console.warn('Failed to send join_ok', e)
      }
    })

    peerService.onMessage('light_up_request', (message) => {
      const typed = message as Extract<PeerMessage, { type: 'light_up_request' }>
      console.log('🔥 HOST: Received light_up_request:', typed.payload)
      const { playerId } = typed.payload

      console.log('🔍 HOST: Processing light_up_request:', {
        requestedPlayerId: playerId,
        gameStarted: gameState.value.gameStarted,
        currentPlayers: gameState.value.players.map((p: any) => ({id: p.id, nickname: p.nickname})),
        playerExists: gameState.value.players.some((p: any) => p.id === playerId),
        currentLitUpPlayerId: gameState.value.litUpPlayerId
      })

      if (gameState.value.gameStarted) {
        const playerExists = gameState.value.players.some((p: any) => p.id === playerId)

        if (playerExists) {
          console.log('✅ HOST: Processing light up for valid player:', playerId)
          gameState.value.litUpPlayerId = playerId

          console.log('📢 HOST: Broadcasting light up state:', {
            litUpPlayerId: gameState.value.litUpPlayerId,
            totalPlayers: gameState.value.players.length,
            playersInState: gameState.value.players.map((p: any) => ({id: p.id, nickname: p.nickname}))
          })

          broadcastGameState()

          // Убираем подсветку через 2 секунды
          setTimeout(() => {
            console.log('⏰ HOST: Clearing light up after timeout')
            gameState.value.litUpPlayerId = null
            broadcastGameState()
          }, 2000)
        } else {
          console.log('❌ HOST: Ignoring light_up_request - player not found:', {
            requestedId: playerId,
            availablePlayers: gameState.value.players.map((p: any) => p.id)
          })
        }
      } else {
        console.log('❌ HOST: Game not started, ignoring light_up_request')
      }
    })

    peerService.onMessage('request_game_state', (message, conn) => {
      if (!conn) return

      const req = (message as Extract<PeerMessage, { type: 'request_game_state' }>).payload as any
      console.log('Host sending game state to client:', conn.peer, 'request:', req, {
        players: gameState.value.players.map((p: Player) => ({ id: p.id, nickname: p.nickname, isHost: p.isHost })),
        roomId: gameState.value.roomId,
        hostId: gameState.value.hostId,
        phase: (gameState.value.phase ?? gamePhase.value) || 'lobby'
      })

      // Перед отправкой убеждаемся, что phase/gameMode синхронизированы с локальными рефами
      gameState.value.phase = gamePhase.value
      gameState.value.gameMode = gameMode.value

      const snapshot = { ...gameState.value }

      // 1) Legacy: отправляем game_state_update (совместимость)
      peerService.sendMessage(
        conn.peer,
        makeMessage(
          'game_state_update',
          snapshot,
          { roomId: snapshot.roomId, fromId: snapshot.hostId, ts: Date.now() }
        )
      )

      // 2) Авторитетный state_snapshot с версией
      try {
        const nowTs = Date.now()
        peerService.sendMessage(
          conn.peer,
          makeMessage(
            'state_snapshot' as any,
            {
              meta: {
                roomId: snapshot.roomId,
                version: currentVersion.value || 0,
                serverTime: nowTs
              },
              state: snapshot
            } as any,
            { roomId: snapshot.roomId, fromId: snapshot.hostId, ts: nowTs }
          )
        )
        console.log('🔼 Host sent state_snapshot in response to request_game_state to:', conn.peer, {
          version: currentVersion.value || 0,
          players: snapshot.players.length,
          phase: snapshot.phase,
          roomId: snapshot.roomId
        })
      } catch (e) {
        console.warn('Failed to send authoritative state_snapshot (request_game_state)', e)
      }
    })

    // -------- Игровые сообщения от клиентов к хосту --------

    // Вытягивание вопроса — разрешено только текущему игроку в фазе drawing_question
    peerService.onMessage('draw_question_request', (message, conn) => {
      const requesterId = conn?.peer || (message as Extract<PeerMessage, { type: 'draw_question_request' }>).payload?.playerId
      console.log('HOST: draw_question_request from', requesterId, 'phase:', gamePhase.value, 'currentTurnPlayerId:', gameState.value.currentTurnPlayerId)
      if (!isHost.value) return
      if (gamePhase.value !== 'drawing_question') return
      if (!requesterId) return

      // Передаём requesterId внутрь drawCard для точной проверки
      const card = drawCard(requesterId)
      if (!card) {
        console.log('Ignored draw_question_request: not allowed or no cards left')
        return
      }
      // drawCard уже делает broadcast
    })

    // Переход к следующей фазе/раунду — доступно ЛЮБОМУ игроку после консенсуса
    peerService.onMessage('next_round_request', (message, conn) => {
      if (!isHost.value) return
      // Разрешаем кнопку только в фазах результатов
      if (gamePhase.value !== 'results' && gamePhase.value !== 'advanced_results') return

      // Проверка консенсуса: все должны завершить свои действия (голос/ставка/догадка)
      const totalPlayers = gameState.value.players.length

      if ((gameState.value.gameMode ?? gameMode.value) === 'basic') {
        const allVoted = Object.keys(gameState.value.votes || {}).length >= totalPlayers
        const allBet = Object.keys(gameState.value.bets || {}).length >= totalPlayers
        const resultsReady = gamePhase.value === 'results' // уже посчитаны очки
        if (!(allVoted && allBet && resultsReady)) return
      } else {
        // advanced
        const votedCount = Object.keys(gameState.value.votes || {}).length
        const guessesCount = Object.keys(gameState.value.guesses || {}).filter(pid => pid !== gameState.value.answeringPlayerId).length
        const requiredGuesses = Math.max(0, totalPlayers - 1)
        const resultsReady = gamePhase.value === 'advanced_results'
        if (!(votedCount >= totalPlayers && guessesCount >= requiredGuesses && resultsReady)) return
      }

      // Выполняем переход хода/сброс раундовых данных
      finishRoundHostOnly()
    })

    // Секретные/обычные голоса
    peerService.onMessage('submit_vote', (message, conn) => {
      if (!isHost.value) return
      // Поддерживаем оба формата: targetIds (новый) и votes (старый)
      const m = message as Extract<PeerMessage, { type: 'submit_vote' }>
      const voterId = (m.payload as any)?.voterId
      const rawVotes = (m.payload as any)?.targetIds ?? (m.payload as any)?.votes
      if (!voterId || !Array.isArray(rawVotes)) return
      if (gamePhase.value !== 'voting' && gamePhase.value !== 'secret_voting') return

      // Нормализуем массив голосов (макс 2, уникальные и не голосуем за себя)
      const uniqueVotes = Array.from(new Set(rawVotes)).slice(0, 2)
      const validVotes = uniqueVotes.filter(id => id && id !== voterId)

      if (!gameState.value.votes) gameState.value.votes = {}
      gameState.value.votes[voterId] = validVotes

      // Инициализируем bets для следующей фазы, чтобы UI мог показывать дефолт («-») и обновлять по мере поступления ставок
      if (!gameState.value.bets) gameState.value.bets = {}

      // Обновляем агрегированные голоса для UI в реальном времени
      const voteCounts: Record<string, number> = {}
      Object.values(gameState.value.votes).forEach((voteArr: string[]) => {
        voteArr.forEach((targetId) => {
          voteCounts[targetId] = (voteCounts[targetId] || 0) + 1
        })
      })
      gameState.value.voteCounts = voteCounts

      // Обновляем состояние для всех клиентов, чтобы они увидели прогресс голосования
      broadcastGameState()

      // Определяем, все ли проголосовали (считаем только реально присутствующих игроков)
      const playersCount = gameState.value.players.length
      const votesCount = Object.keys(gameState.value.votes).length

      if (votesCount >= playersCount) {
        if (gameMode.value === 'basic') {
          // Переход к ставкам
          gamePhase.value = 'betting'
          gameState.value.phase = 'betting'

          // Гарантируем, что в bets есть ключи для всех игроков (значение undefined не сохраняем, UI использует bets[p.id] || '-')
          gameState.value.players.forEach(p => {
            if (gameState.value.bets![p.id] === undefined) {
              // ничего не присваиваем, просто убеждаемся, что объект существует
            }
          })

          broadcastGameState()
        } else {
          // advanced: уже есть voteCounts — выбираем отвечающего и переходим к answering
          const maxVotes = Math.max(0, ...Object.values(voteCounts))
          const leaders = Object.entries(voteCounts)
            .filter(([_, c]) => c === maxVotes && maxVotes > 0)
            .map(([pid]) => pid)
          gameState.value.answeringPlayerId = leaders[0] || null

          gamePhase.value = 'answering'
          gameState.value.phase = 'answering'
          broadcastGameState()
        }
      }
    })

    // Ставки в basic
    peerService.onMessage('submit_bet', (message) => {
      if (!isHost.value) return
      if (gameMode.value !== 'basic') return
      if (gamePhase.value !== 'betting') return

      const payload = (message as Extract<PeerMessage, { type: 'submit_bet' }>).payload
      const playerId = (payload as any).playerId as string | undefined
      const bet = (payload as any).bet as ('0' | '±' | '+') | undefined

      if (!playerId || !bet) return

      // Дедупликация: не позволяем менять ставку после первого принятия
      if (!gameState.value.bets) gameState.value.bets = {}
      if (gameState.value.bets[playerId]) {
        // Игрок уже сделал ставку — повторный submit игнорируем
        return
      }

      gameState.value.bets[playerId] = bet

      const playersCount = gameState.value.players.length
      const betsCount = Object.keys(gameState.value.bets).length

      if (betsCount >= playersCount) {
        // Все поставили — считаем раунд и в results
        processRound()
        gamePhase.value = 'results'
        gameState.value.phase = 'results'
      }

      // Важно: сразу рассылаем обновленное состояние, чтобы у клиента отобразилась выбранная ставка
      broadcastGameState()
    })

    // Ответ отвечающего (advanced)
    peerService.onMessage('submit_answer', (message) => {
      if (!isHost.value) return
      if (gameMode.value !== 'advanced') return
      if (gamePhase.value !== 'answering') return
      const payload = (message as Extract<PeerMessage, { type: 'submit_answer' }>).payload
      // Валидация и доступ к полям строго по типу SubmitAnswerPayload
      const playerId = (payload as any).playerId as string | undefined
      const answer = (payload as any).answer as string | undefined
      if (!playerId || typeof answer !== 'string') return

      // Только выбранный отвечающий может отправить ответ
      if (playerId !== gameState.value.answeringPlayerId) return

      gameState.value.advancedAnswer = answer
      gamePhase.value = 'guessing'
      gameState.value.phase = 'guessing'
      broadcastGameState()
    })

    // Догадки (advanced)
    peerService.onMessage('submit_guess', (message) => {
      if (!isHost.value) return
      if (gameMode.value !== 'advanced') return
      if (gamePhase.value !== 'guessing') return
      const payload = (message as Extract<PeerMessage, { type: 'submit_guess' }>).payload
      const playerId = (payload as any).playerId as string | undefined
      const guess = (payload as any).guess as string | undefined
      if (!playerId || typeof guess !== 'string') return

      if (!gameState.value.guesses) gameState.value.guesses = {}
      gameState.value.guesses[playerId] = guess

      const playersCount = gameState.value.players.length
      const requiredGuesses = Math.max(0, playersCount - 1) // все кроме отвечающего
      const guessesCount = Object.keys(gameState.value.guesses).filter(pid => pid !== gameState.value.answeringPlayerId).length

      // Когда получили все догадки, ПЕРЕХОДИМ В selecting_winners, без начисления очков
      if (guessesCount >= requiredGuesses) {
        gamePhase.value = 'selecting_winners'
        gameState.value.phase = 'selecting_winners'
        if (!gameState.value.roundWinners) gameState.value.roundWinners = []
      }

      broadcastGameState()
    })

    // Обработка выбора победителей в advanced от клиента (строгая авторизация: только автор ответа)
    peerService.onMessage('submit_winners', (message) => {
      if (!isHost.value) return
      if ((gameState.value.gameMode ?? gameMode.value) !== 'advanced') return
      if ((gameState.value.phase ?? gamePhase.value) !== 'selecting_winners') return

      const payload = (message as Extract<PeerMessage, { type: 'submit_winners' }>).payload as any
      const chooserId = payload?.chooserId as string | undefined
      const rawWinners = (payload?.winners as string[] | undefined) || []

      // Строгая проверка: выбирает только автор ответа
      if (!chooserId || chooserId !== gameState.value.answeringPlayerId) return

      // Нормализация winners: уникальные, только игроки с guesses, исключая chooserId
      const validSet = new Set(
        rawWinners
          .filter(id =>
            id &&
            id !== chooserId &&
            !!(gameState.value.guesses && gameState.value.guesses[id] !== undefined) &&
            gameState.value.players.some(p => p.id === id)
          )
      )
      const winners = Array.from(validSet)

      // Применяем логику начисления и перехода фазы
      submitWinners(winners)
    })

    // Добавляем обработчики host discovery
    setupHostDiscoveryHandlers()

    // Добавляем обработчики mesh-протокола
    setupMeshProtocolHandlers()
  }

  // Настройка обработчиков сообщений для клиента
  const setupClientMessageHandlers = () => {
    console.log('Setting up client message handlers')

    // КРИТИЧНО: Очищаем старые обработчики перед настройкой новых
    peerService.clearMessageHandlers()
    console.log('Cleared old message handlers before setting up client handlers')

    // Перед ожиданием снапшота сбрасываем барьер и включаем таймер фолбэка
    try {
      if (_snapshotTimeoutHandle) {
        clearTimeout(_snapshotTimeoutHandle)
        _snapshotTimeoutHandle = null
      }
      _acceptLegacyAsInit.value = false
      initReceived.value = false
      _snapshotTimeoutHandle = window.setTimeout(() => {
        if (!initReceived.value) {
          _acceptLegacyAsInit.value = true
        }
      }, SNAPSHOT_TIMEOUT_MS)
    } catch {}

    // Versioned sync handlers (prioritized)
    peerService.onMessage('state_snapshot', (message) => {
      if (isHost.value) return
      const payload = (message as Extract<PeerMessage, { type: 'state_snapshot' }>).payload as any
      const meta = payload?.meta
      console.log('📥 CLIENT received state_snapshot:', {
        meta,
        hasRoom: !!gameState.value.roomId,
        currentRoom: gameState.value.roomId || '(empty)',
        incomingRoom: meta?.roomId,
        playersInPayload: Array.isArray(payload?.state?.players) ? payload.state.players.length : -1,
        phase: payload?.state?.phase
      })
      if (!meta || (gameState.value.roomId && meta.roomId !== gameState.value.roomId)) {
        console.warn('state_snapshot ignored due to room mismatch or missing meta')
        return
      }
      // Snapshot barrier: применяем целиком
      const incoming = { ...(payload.state || {}) }
      // Защита: синхронизируем ключевые поля
      if (incoming.hostId && !incoming.players?.some((p: Player) => p.id === incoming.hostId)) {
        console.warn('Snapshot hostId not found among players, will keep as-is but UI may not highlight host')
      }
      gameState.value = incoming
      // Дублируем в локальные вспомогательные поля
      hostId.value = incoming.hostId || hostId.value
      roomId.value = incoming.roomId || roomId.value

      currentVersion.value = typeof meta.version === 'number' ? meta.version : 0
      lastServerTime.value = Math.max(lastServerTime.value, meta.serverTime || Date.now())
      initReceived.value = true

      console.log('✅ CLIENT applied snapshot:', {
        players: gameState.value.players.length,
        myPlayerId: myPlayerId.value,
        hostId: hostId.value,
        roomId: roomId.value,
        phase: gameState.value.phase
      })

      // Очищаем таймер ожидания снапшота и сбрасываем легаси-флаг
      if (_snapshotTimeoutHandle) {
        clearTimeout(_snapshotTimeoutHandle)
        _snapshotTimeoutHandle = null
      }
      _acceptLegacyAsInit.value = false

      // Drain buffered diffs
      drainPending()
      // Ack
      sendAck(currentVersion.value)
    })

    peerService.onMessage('state_diff', (message) => {
      if (isHost.value) return
      const payload = (message as Extract<PeerMessage, { type: 'state_diff' }>).payload as any
      const meta = payload?.meta
      console.log('📥 CLIENT received state_diff:', {
        meta,
        hasInit: initReceived.value,
        currentVersion: currentVersion.value
      })
      if (!meta || (gameState.value.roomId && meta.roomId !== gameState.value.roomId)) {
        console.warn('state_diff ignored due to room mismatch or missing meta')
        return
      }
      if (!initReceived.value) {
        // buffer until snapshot
        if (typeof meta.version === 'number') {
          pendingDiffs.value.set(meta.version, payload)
          console.log('Buffered diff before init, version:', meta.version)
        }
        return
      }
      // Gap detection
      const expected = (currentVersion.value || 0) + 1
      if (meta.version !== expected) {
        console.warn('Diff version gap detected, expected:', expected, 'got:', meta.version)
        if (typeof meta.version === 'number') pendingDiffs.value.set(meta.version, payload)
        // request resync if we see jump ahead without pending chain
        requestResync(currentVersion.value)
        return
      }
      // Apply
      applyDiff(payload.patch)
      currentVersion.value = meta.version
      lastServerTime.value = Math.max(lastServerTime.value, meta.serverTime || Date.now())
      console.log('✅ CLIENT applied diff:', { newVersion: currentVersion.value })
      // Drain any consecutive buffered diffs
      drainPending()
      // Ack
      sendAck(currentVersion.value)
    })

    // Клиентские уведомления о присутствии
    peerService.onMessage('user_joined_broadcast', (message) => {
      const { userId, roomId: rid, timestamp } = (message as Extract<PeerMessage, { type: 'user_joined_broadcast' }>).payload as any
      if (!gameState.value.presence) gameState.value.presence = {}
      if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
      gameState.value.presence[userId] = 'present'
      gameState.value.presenceMeta[userId] = {
        lastSeen: Math.max(timestamp || Date.now(), gameState.value.presenceMeta[userId]?.lastSeen || 0)
      }
      // Здесь позже будет UI: ARIA-live/тосты
    })

    peerService.onMessage('user_left_broadcast', (message) => {
      const { userId, roomId: rid, timestamp, reason } = (message as Extract<PeerMessage, { type: 'user_left_broadcast' }>).payload as any
      if (!gameState.value.presence) gameState.value.presence = {}
      if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
      // Идемпотентно помечаем отсутствующим
      const ts = timestamp || Date.now()
      const prevMeta = gameState.value.presenceMeta[userId]
      const alreadyAbsent = gameState.value.presence?.[userId] === 'absent' && prevMeta?.leftAt && prevMeta.leftAt >= ts
      if (!alreadyAbsent) {
        gameState.value.presence[userId] = 'absent'
        gameState.value.presenceMeta[userId] = {
          lastSeen: Math.max(ts, prevMeta?.lastSeen || 0),
          leftAt: ts,
          reason: reason || 'explicit_leave'
        }
      }
      // ARIA уведомление
      ariaAnnounce('Пользователь покинул комнату')
    })

    // Подписка на восстановление исходного хоста во время grace-period
    try {
      peerService.onHostRecovered(() => {
        console.log('🎉 onHostRecovered: Original host is back, cancelling migration/grace and marking connected')
        // Отменяем Grace-period если активен
        try {
          if (peerService.isInHostRecoveryGracePeriod()) {
            peerService.cancelHostRecoveryGracePeriod()
          }
        } catch {}
        // Сбрасываем состояние миграции, если что-то шло
        if (migrationState.value.inProgress) {
          resetMigrationState()
        }
        // Ставим статус connected — дальнейшая синхронизация придет через heartbeat/game_state_update
        connectionStatus.value = 'connected'
      })
    } catch (e) {
      console.warn('Failed to subscribe to onHostRecovered (non-critical):', e)
    }

    peerService.onMessage('game_state_update', (message) => {
      // Защита: принимаем только если мы клиент (у хоста истина в локальном состоянии)
      if (isHost.value) return

      const newState = { ...(message as Extract<PeerMessage, { type: 'game_state_update' }>).payload }
      console.log('📥 CLIENT received game_state_update:', {
        players: Array.isArray(newState.players) ? newState.players.map((p: Player) => ({ id: p.id, nick: p.nickname })) : [],
        hostId: newState.hostId,
        roomId: newState.roomId,
        phase: newState.phase
      })

      // Fallback инициализация: если не получили авторитетный снапшот вовремя,
      // принимаем первый legacy апдейт как первичный снимок
      if (!initReceived.value && _acceptLegacyAsInit.value) {
        gameState.value = newState
        currentVersion.value = 0
        lastServerTime.value = Date.now()
        initReceived.value = true
        if (_snapshotTimeoutHandle) {
          clearTimeout(_snapshotTimeoutHandle)
          _snapshotTimeoutHandle = null
        }
        _acceptLegacyAsInit.value = false
        console.log('🆗 CLIENT accepted legacy game_state_update as initial snapshot (timeout fallback)')
      }

      // Немедленно кешируем снапшот состояния, полученный от хоста, с TTL
      try {
        storageSafe.setWithTTL('game', 'hostGameStateSnapshot', { ts: Date.now(), state: newState }, HOST_SNAPSHOT_TTL)
      } catch (e) {
        console.warn('Failed to cache host snapshot on client', e)
      }
      // Обновим устойчивый roomId
      try {
        if (newState?.roomId) {
          savePersistentRoomId(newState.roomId)
        }
      } catch {}

      // КРИТИЧНО: Валидируем litUpPlayerId при получении обновления состояния
      if (newState.litUpPlayerId) {
        console.log('🔍 VALIDATING litUpPlayerId:', {
          litUpPlayerId: newState.litUpPlayerId,
          playersInState: newState.players.map((p: Player) => ({id: p.id, nickname: p.nickname})),
          myPlayerId: myPlayerId.value,
          totalPlayers: newState.players.length
        })

        const litUpPlayerExists = newState.players.some((p: Player) => p.id === newState.litUpPlayerId);
        if (!litUpPlayerExists) {
          console.log('🧹 Received invalid litUpPlayerId, clearing it:', {
            invalidId: newState.litUpPlayerId,
            availablePlayerIds: newState.players.map((p: Player) => p.id),
            playersWithNicknames: newState.players.map((p: Player) => ({id: p.id, nickname: p.nickname}))
          })
          newState.litUpPlayerId = null
        } else {
          console.log('✅ litUpPlayerId is valid, keeping it:', newState.litUpPlayerId)
        }
      }

      // Отметим, что получили свежее состояние — можно останавливать ретраи
      try { gotFreshState.value = true } catch {}

      // Синхронизация критичных полей в локальные refs
      if (newState.hostId) hostId.value = newState.hostId
      if (newState.roomId) roomId.value = newState.roomId

      gameState.value = newState

      console.log('✅ CLIENT applied game_state_update:', {
        players: gameState.value.players.length,
        hostId: hostId.value,
        roomId: roomId.value,
        phase: gameState.value.phase
      })
    })

    peerService.onMessage('player_id_updated', (message) => {
      const { oldId, newId, message: updateMessage } = (message as Extract<PeerMessage, { type: 'player_id_updated' }>).payload
      console.log('🔄 CLIENT: Received player_id_updated message:', {
        oldId,
        newId,
        updateMessage
      })

      if (myPlayerId.value === oldId) {
        console.log('✅ CLIENT: Updating myPlayerId from old ID to new ID:', {
          oldId,
          newId
        })
        myPlayerId.value = newId
        // КРИТИЧНО: обновляем устойчивый идентификатор
        try { saveStablePlayerId(newId) } catch {}
      } else {
        console.log('❌ CLIENT: Ignoring player_id_updated message - old ID does not match:', {
          currentId: myPlayerId.value,
          oldId
        })
      }
    })

    peerService.onMessage('heartbeat', (message) => {
      const { hostId: heartbeatHostId } = (message as Extract<PeerMessage, { type: 'heartbeat' }>).payload
      peerService.handleHeartbeat(heartbeatHostId)
    })

    // Настройка callback для обнаружения отключения хоста
    peerService.onHostDisconnected(() => {
      onHostDisconnectedSafe()
    })

    // Добавляем обработчики миграции
    setupMigrationHandlers()

    // Добавляем обработчики host discovery
    setupHostDiscoveryHandlers()

    // Добавляем обработчики mesh-протокола
    setupMeshProtocolHandlers()
  }

  // Рассылка состояния игры всем участникам
  const broadcastGameState = () => {
    if (isHost.value) {
      // Дублируем phase/режим в объект состояния для клиентов
      gameState.value.phase = gamePhase.value
      // Ведущий режим определяется по currentRound, синхронизируем из currentMode
      gameMode.value = currentMode.value
      gameState.value.gameMode = currentMode.value

      // Всегда шлем свежую копию, чтобы избежать мутаций по ссылке у клиентов
      const snapshot = { ...gameState.value }

      // Пишем снапшот хоста в storageSafe с TTL, чтобы клиенты могли «якориться» после перезагрузки
      try {
        storageSafe.setWithTTL('game', 'hostGameStateSnapshot', { ts: Date.now(), state: snapshot }, HOST_SNAPSHOT_TTL)
      } catch (e) {
        console.warn('Failed to persist host snapshot', e)
      }

      peerService.broadcastMessage(
        makeMessage(
          'game_state_update',
          snapshot,
          { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() }
        )
      )
    }
  }

  // --- Удалены дублирующиеся функции ---

  // Подсветка игрока
  const lightUpPlayer = () => {
    console.log('lightUpPlayer called:', {
      gameStarted: gameState.value.gameStarted,
      myPlayerId: myPlayerId.value,
      isHost: isHost.value,
      hostId: hostId.value,
      connectionStatus: connectionStatus.value
    })

    if (!gameState.value.gameStarted || !myPlayerId.value) {
      console.log('lightUpPlayer aborted: game not started or no player ID')
      return
    }

    if (isHost.value) {
      console.log('Host processing light up locally')
      // Хост обрабатывает запрос локально
      gameState.value.litUpPlayerId = myPlayerId.value
      broadcastGameState()

      setTimeout(() => {
        gameState.value.litUpPlayerId = null
        broadcastGameState()
      }, 2000)
    } else {
      console.log('Client sending light_up_request to host:', hostId.value)
      // Клиент отправляет запрос хосту
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'light_up_request',
          { playerId: myPlayerId.value },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  // Состояние миграции
  const migrationState = ref<{
    inProgress: boolean
    phase: 'proposal' | 'voting' | 'confirmed' | null
    proposedHostId: string | null
    votes: Map<string, 'approve' | 'reject'>
    timeout: number | null
    // Расширение: жёсткая блокировка экстренного захвата,
    // когда детерминированный новый хост уже определён и это не мы
    emergencyLock?: boolean
  }>({
    inProgress: false,
    phase: null,
    proposedHostId: null,
    votes: new Map(),
    timeout: null,
    emergencyLock: false
  })


  // Попытки переподключения к отключившемуся хосту
  const attemptReconnectionToHost = async (hostId: string) => {
    console.log('🔄 Attempting to reconnect to host:', hostId)

    const maxAttempts = 5
    const attemptInterval = 3000 // 3 секунды между попытками

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`🔍 Reconnection attempt ${attempt}/${maxAttempts} to host:`, hostId)

      try {
        // Пытаемся переподключиться к тому же хосту
        await peerService.connectToHost(hostId)

        // Если успешно - восстанавливаем состояние клиента
        peerService.setAsClient()
        setupClientMessageHandlers()

        // Отправляем запрос на подключение с сохраненным устойчивым ID для повторного подключения
        peerService.sendMessage(
          hostId,
          makeMessage(
            'join_request',
            {
              nickname: myNickname.value,
              savedPlayerId: loadStablePlayerId() || myPlayerId.value
            },
            { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
          )
        )

        // Запрашиваем актуальное состояние игры
        peerService.sendMessage(
          hostId,
          makeMessage(
            'request_game_state',
            { requesterId: myPlayerId.value },
            { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
          )
        )

        connectionStatus.value = 'connected'
        console.log('✅ Successfully reconnected to host:', hostId)
        return

      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error('Failed to reconnect to host:', error.message);
        } else {
          console.error('An unknown error occurred during reconnection.');
        }
      if (error instanceof Error) {
        console.error('Failed to create room:', error.message);
      } else {
        console.error('An unknown error occurred during room creation.');
      }
        console.log(`❌ Reconnection attempt ${attempt} failed:`, error)

        if (attempt < maxAttempts) {
          console.log(`⏳ Waiting ${attemptInterval}ms before next attempt...`)
          await new Promise(resolve => setTimeout(resolve, attemptInterval))
        }
      }
    }

    // Если успешно переподключились ранее — отменяем grace period
    try {
      if (connectionStatus.value === 'connected') {
        peerService.cancelHostRecoveryGracePeriod()
      }
    } catch {}

    // Все попытки неудачны
    console.log('❌ All reconnection attempts failed. Host is likely permanently disconnected.')
    connectionStatus.value = 'disconnected'

    // Можно добавить логику для отображения сообщения пользователю
    // о том, что хост недоступен и нужно покинуть комнату
  }

  // Безопасный враппер: обработка отключения хоста
  const onHostDisconnectedSafe = async () => {
    try {
      await attemptReconnectionToHost(hostId.value || gameState.value.hostId)
    } catch (e) {
      console.warn('onHostDisconnectedSafe: reconnection failed, proceeding to migration after grace', e)
    }
  }

  // Продолжение с миграцией после завершения grace period
  const proceedWithMigrationAfterGracePeriod = async (originalHostId: string) => {
    try {
      console.log('🔄 Grace period completed, starting migration process...')
      console.log('🔍 MIGRATION START STATE:', {
        originalHostId,
        currentGameStatePlayers: gameState.value.players.map((p: Player) => ({id: p.id, nickname: p.nickname, isHost: p.isHost})),
        myPlayerId: myPlayerId.value,
        connectionStatus: connectionStatus.value,
        migrationInProgress: migrationState.value.inProgress,
        peerRecoveryState: peerService.getHostRecoveryState()
      })

      // Удаляем отключенного хоста из списка игроков
      const playersBeforeFilter = gameState.value.players.length
      gameState.value.players = gameState.value.players.filter((p: Player) => p.id !== originalHostId)
      const playersAfterFilter = gameState.value.players.length

      console.log('🔍 PLAYER FILTERING:', {
        originalHostId,
        playersBeforeFilter,
        playersAfterFilter,
        remainingPlayers: gameState.value.players.map((p: Player) => ({id: p.id, nickname: p.nickname, authToken: !!p.authToken}))
      })

      // Проверяем токены оставшихся игроков
      const validPlayers = gameState.value.players.filter((p: Player) => validateAuthToken(p))
      console.log('🔍 TOKEN VALIDATION:', {
        totalPlayers: gameState.value.players.length,
        validPlayers: validPlayers.length,
        invalidPlayers: gameState.value.players
          .filter((p: Player) => !validateAuthToken(p))
          .map((p: Player) => ({
            id: p.id,
            nickname: p.nickname,
            hasToken: !!p.authToken
          }))
      } as {
        totalPlayers: number
        validPlayers: number
        invalidPlayers: Array<{ id: string; nickname: string; hasToken: boolean }>
      })

      if (validPlayers.length === 0) {
        throw new Error('No valid players remaining after grace period')
      }

      console.log('Valid players remaining after grace period:', (validPlayers as Player[]).map((p: Player) => ({
        id: p.id,
        nickname: p.nickname
      })))

      // Быстрая проверка - может кто-то уже стал хостом во время grace period
      console.log('Final check: Quick host discovery among remaining players...')
      console.log('🔍 DISCOVERY ATTEMPT STATE:', {
        validPlayersCount: validPlayers.length,
        peerState: peerService.getCurrentRole(),
        myPeerId: peerService.getMyId(),
        activeConnections: peerService.getActiveConnections()
      })

      const discoveredHost = await quickHostDiscovery(validPlayers as Player[])

      console.log('🔍 DISCOVERY RESULT:', {
        discoveredHost: discoveredHost ? {
          hostId: discoveredHost.currentHostId,
          isHost: discoveredHost.isHost,
          responderId: discoveredHost.responderId
        } : null
      })

      if (discoveredHost) {
        console.log('Found existing host during final check, reconnecting:', discoveredHost.currentHostId)
        await reconnectToDiscoveredHost(discoveredHost)
        return
      }

      // Проверяем активные соединения
      const activeConnections = peerService.getActiveConnections()
      const openConnections = activeConnections.filter((c: { peerId: string; isOpen: boolean }) => c.isOpen)
      console.log('🔍 CONNECTION ANALYSIS:', {
        totalConnections: activeConnections.length,
        openConnections: openConnections.length,
        connectionDetails: activeConnections.map((c: { peerId: string; isOpen: boolean }) => ({peerId: c.peerId, isOpen: c.isOpen})),
        knownPeers: peerService.getAllKnownPeers()
      })

      if (openConnections.length === 0) {
        console.log('No active connections, using deterministic fallback...')

        // Fallback: Детерминированный выбор хоста без голосования
        const deterministicHost = electHostDeterministic(validPlayers)
        console.log('🔍 DETERMINISTIC ELECTION:', {
          selectedHostId: deterministicHost,
          myPlayerId: myPlayerId.value,
          amISelected: deterministicHost === myPlayerId.value,
          validPlayersForElection: validPlayers.map((p: Player) => ({id: p.id, nickname: p.nickname}))
        })

        if (deterministicHost === myPlayerId.value) {
          console.log('I am deterministic host, becoming host...')
          await becomeNewHostWithRecovery(originalHostId)
          return
        } else {
          console.log('Waiting for deterministic host to initialize...')
          console.log('🔍 WAITING FOR DETERMINISTIC HOST:', {
            waitingForHostId: deterministicHost,
            waitTimeSeconds: 3,
            willRetryDiscovery: true
          })

          // Даем время детерминированному хосту инициализироваться
          setTimeout(async () => {
            console.log('Attempting to reconnect to deterministic host...')
            console.log('🔍 RETRY DISCOVERY STATE:', {
              targetHostId: deterministicHost,
              myCurrentState: {
                peerId: peerService.getMyId(),
                connectionStatus: connectionStatus.value,
                activeConnections: peerService.getActiveConnections()
              }
            })

            // Пытаемся найти нового хоста еще раз
            const finalHost = await quickHostDiscovery(validPlayers)
            console.log('🔍 FINAL DISCOVERY RESULT:', {
              finalHost: finalHost ? {
                hostId: finalHost.currentHostId,
                isHost: finalHost.isHost
              } : null
            })

            if (finalHost) {
              await reconnectToDiscoveredHost(finalHost)
            } else {
              console.log('🔍 NO HOST FOUND, EMERGENCY TAKEOVER:', {
                myPlayerId: myPlayerId.value,
                originalHostId,
                reason: 'No deterministic host found after wait period'
              })
              // Если никого не нашли - сами становимся хостом
              await becomeNewHostWithRecovery(originalHostId)
            }
          }, 3000)
          return
        }
      }

      // Если есть активные соединения - запускаем полную миграцию
      console.log('🔍 STARTING SECURE MIGRATION:', {
        validPlayersCount: validPlayers.length,
        openConnectionsCount: openConnections.length,
        migrationReason: 'Active connections available'
      })
      await startSecureMigration(validPlayers)

    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('❌ Failed to proceed with migration after grace period:', error.message)
      } else {
        console.error('❌ Failed to proceed with migration after grace period: Unknown error')
      }
      console.log('🔍 MIGRATION ERROR STATE:', {
        error: (error as any)?.message,
        connectionStatus: connectionStatus.value,
        gameState: {
          playersCount: gameState.value.players.length,
          hostId: gameState.value.hostId
        },
        peerState: {
          role: peerService.getCurrentRole(),
          connections: peerService.getActiveConnections(),
          recoveryState: peerService.getHostRecoveryState()
        }
      })
      connectionStatus.value = 'disconnected'
    }
  }

  // Быстрый опрос хоста среди оставшихся игроков (используя основной peer)
  const quickHostDiscovery = async (players: Player[]): Promise<HostDiscoveryResponsePayload | null> => {
    console.log('Starting quick host discovery among remaining players...')

    if (players.length === 0) return null

    return new Promise(async (resolve) => {
      let discoveredHost: HostDiscoveryResponsePayload | null = null
      let responsesReceived = 0
      const maxResponses = players.length

      // ИСПРАВЛЕНО: Используем основной peer вместо временного
      const mainPeer = peerService.getPeer()
      if (!mainPeer || !mainPeer.open) {
        console.log('Main peer not available for discovery')
        resolve(null)
        return
      }

      console.log('Quick discovery with short timeout for', players.length, 'players')

      const discoveryRequest: HostDiscoveryRequestPayload = {
        requesterId: mainPeer.id,
        requesterToken: myPlayer.value?.authToken || '',
        timestamp: Date.now()
      }

      console.log('🔍 DISCOVERY REQUEST PAYLOAD:', discoveryRequest)

      const connectionsToCleanup: any[] = []
      const savedConnections: string[] = []

      // Попытка подключения к каждому игроку
      for (const player of players) {
        try {
          const conn = mainPeer.connect(player.id)

          conn.on('open', () => {
            console.log('Quick discovery connected to:', player.id)

            // КРИТИЧНО: Сохраняем соединение в PeerService для дальнейшего использования
            peerService.addConnection(player.id, conn)
            savedConnections.push(player.id)

            conn.send({
              type: 'host_discovery_request',
              payload: discoveryRequest
            })
          })

          conn.on('data', (data: any) => {
            const message = data as PeerMessage
            if (message.type === 'host_discovery_response') {
              const response = message.payload as HostDiscoveryResponsePayload
              console.log('Quick discovery response:', response)

              responsesReceived++

              if (response.isHost && !discoveredHost) {
                discoveredHost = response
                console.log('Quick discovery found host:', response.currentHostId)
                finishDiscovery()
                resolve(discoveredHost)
                return
              }

              if (responsesReceived >= maxResponses) {
                finishDiscovery()
                resolve(discoveredHost)
              }
            }
          })

          conn.on('error', () => {
            responsesReceived++
            if (responsesReceived >= maxResponses) {
              finishDiscovery()
              resolve(discoveredHost)
            }
          })

          // Добавляем в список для потенциальной очистки
          connectionsToCleanup.push(conn)

        } catch (error: any) {
          responsesReceived++
          if (responsesReceived >= maxResponses) {
            finishDiscovery()
            resolve(discoveredHost)
          }
        }
      }

      // Короткий таймаут для быстрого discovery
      setTimeout(() => {
        console.log('Quick discovery timeout')
        finishDiscovery()
        resolve(discoveredHost)
      }, 2000) // 2 секунды

      function finishDiscovery() {
        // ИСПРАВЛЕНО: НЕ закрываем соединения, которые сохранены в PeerService
        connectionsToCleanup.forEach(conn => {
          // Закрываем только те соединения, которые НЕ были сохранены
          if (!peerService.hasConnection(conn.peer)) {
            try {
              console.log('Closing unsaved discovery connection:', conn.peer)
              conn.close()
            } catch (e) { /* ignore */
            }
          } else {
            console.log('Keeping saved connection:', conn.peer)
          }
        })

        console.log('Discovery completed, saved connections:', savedConnections)
      }
    })
  }

  // Переподключение к обнаруженному хосту
  const reconnectToDiscoveredHost = async (discoveredHost: HostDiscoveryResponsePayload) => {
    console.log('Reconnecting to discovered host:', discoveredHost.currentHostId)

    try {
      connectionStatus.value = 'connecting'

      // Переподключаемся к найденному хосту
      await peerService.reconnectToNewHost(discoveredHost.currentHostId)

      // Обновляем состояние
      isHost.value = false
      hostId.value = discoveredHost.currentHostId
      gameState.value.hostId = discoveredHost.currentHostId

      // Синхронизируем состояние игры с найденным хостом
      gameState.value = {...discoveredHost.gameState}

      // Устанавливаем роль клиента
      peerService.setAsClient()

      // Настраиваем обработчики для клиента
      setupClientMessageHandlers()

      // Запрашиваем актуальное состояние игры
      peerService.sendMessage(
        discoveredHost.currentHostId,
        makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      connectionStatus.value = 'connected'
      console.log('Successfully reconnected to discovered host')

    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to reconnect to discovered host:', error.message)
      } else {
        console.error('Failed to reconnect to discovered host: Unknown error')
      }
      connectionStatus.value = 'disconnected'
      throw error as any
    }
  }

  // Запуск безопасной миграции
  // BUGFIX: защита от повторного запуска миграции, если уже идет процесс
  const startSecureMigration = async (validPlayers: Player[]) => {
    if (migrationState.value.inProgress) {
      console.log('Migration already in progress, skip startSecureMigration')
      return
    }
    console.log('Starting secure migration with players:', validPlayers.map(p => p.id))

    migrationState.value.inProgress = true
    migrationState.value.phase = 'proposal'

    try {
      // Фаза 1: Детерминированный выбор нового хоста
      const proposedHost = electNewHostFromValidPlayers(validPlayers)
      migrationState.value.proposedHostId = proposedHost.id

      console.log('Proposed new host:', proposedHost.id)

      if (proposedHost.id === myPlayerId.value) {
        // Я предложен как новый хост
        await initiateHostMigration(proposedHost)
      } else {
        // Участвую в голосовании
        await participateInMigration(proposedHost)
      }

    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Secure migration failed:', error.message)
      } else {
        console.error('Secure migration failed: Unknown error')
      }
      resetMigrationState()
      throw error as any
    }
  }

  // Выбор нового хоста из валидных игроков
  const electNewHostFromValidPlayers = (validPlayers: Player[]): Player => {
    // Новый критерий: минимальный players[i].id (peerId) лексикографически
    const sortedPlayers = validPlayers
      .slice()
      .sort((a: Player, b: Player) => a.id.localeCompare(b.id))

    if (sortedPlayers.length === 0) {
      throw new Error('No valid players for host election')
    }

    console.log('🔍 HOST ELECTION ALGORITHM:', {
      validPlayers: (validPlayers as Player[]).map((p: Player) => ({ id: p.id, nickname: p.nickname })),
      sortedPlayers: (sortedPlayers as Player[]).map((p: Player) => ({ id: p.id, nickname: p.nickname })),
      selectedHost: sortedPlayers[0],
      myPlayerId: myPlayerId.value,
      amISelected: sortedPlayers[0].id === myPlayerId.value
    })

    return sortedPlayers[0]
  }

  // Инициация миграции хоста (новый хост)
  const initiateHostMigration = async (proposedHost: Player) => {
    console.log('Initiating host migration as new host...')

    migrationState.value.phase = 'voting'

    // Отправляем предложение миграции всем оставшимся игрокам
    const proposal: MigrationProposalPayload = {
      proposedHostId: proposedHost.id,
      proposedHostToken: proposedHost.authToken,
      reason: 'host_disconnected',
      timestamp: Date.now()
    }

    // КРИТИЧНО: Рассылаем напрямую каждому игроку вместо broadcast
    const validPlayers = gameState.value.players.filter(p => p.id !== myPlayerId.value)
    console.log('Sending migration proposal to players:', validPlayers.map(p => p.id))

    for (const player of validPlayers) {
      if (peerService.hasConnection(player.id)) {
        console.log('Sending migration proposal to:', player.id)
        peerService.sendMessage(
          player.id,
          makeMessage(
            'migration_proposal',
            proposal,
            { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
          )
        )
      } else {
        console.log('No connection to player for migration proposal:', player.id)
      }
    }

    // Устанавливаем таймаут для голосования
    migrationState.value.timeout = window.setTimeout(() => {
      handleMigrationTimeout()
    }, VOTE_TIMEOUT)

    // Автоматически голосуем за себя
    migrationState.value.votes.set(myPlayerId.value, 'approve')

    try {
      // Ждем голосов от других игроков
      await waitForMigrationVotes()
    } catch (error) {
      console.log('🚨 Migration voting failed, proceeding with emergency host assumption...')
      forceMigrationComplete()
    }
  }

  // Участие в миграции (клиент)
  const participateInMigration = async (proposedHost: Player) => {
    console.log('Participating in migration, proposed host:', proposedHost.id)

    migrationState.value.phase = 'voting'

    // УДАЛЕНО: setupMigrationHandlers() - уже настроен в setupClientMessageHandlers
    // Обработчики migration_proposal будут автоматически обрабатывать сообщения

    console.log('Migration handlers already set up, waiting for migration_proposal message...')

    // НЕ отправляем голос сразу - ждем получения migration_proposal
    // Голос будет отправлен автоматически в обработчике migration_proposal
  }

  // Настройка обработчиков миграции
  const setupMigrationHandlers = () => {
    console.log('🔧 Setting up migration handlers')

    peerService.onMessage('migration_proposal', (message, conn) => {
      const payload = message.payload as MigrationProposalPayload
      console.log('🚨 RECEIVED MIGRATION PROPOSAL:', {
        payload,
        fromPeer: conn?.peer,
        myPlayerId: myPlayerId.value,
        isHost: isHost.value,
        migrationInProgress: migrationState.value.inProgress,
        connectionStatus: connectionStatus.value,
        gameState: {
          hostId: gameState.value.hostId,
          playersCount: gameState.value.players.length
        }
      })

      // Проверяем текущее состояние
      if (isHost.value) {
        console.log('❌ Received migration proposal while being host, ignoring')
        return
      }

      if (migrationState.value.inProgress) {
        console.log('❌ Migration already in progress, ignoring proposal')
        return
      }

      // Валидируем предложение
      console.log('🔍 VALIDATING MIGRATION PROPOSAL:', {
        proposedHostId: payload.proposedHostId,
        currentPlayers: gameState.value.players.map(p => ({id: p.id, nickname: p.nickname, authToken: !!p.authToken})),
        proposedHostToken: payload.proposedHostToken ? 'present' : 'missing'
      })

      if (validateMigrationProposal(payload)) {
        console.log('✅ Migration proposal validated, sending vote...')
        migrationState.value.proposedHostId = payload.proposedHostId
        migrationState.value.phase = 'voting'
        migrationState.value.inProgress = true

        // КРИТИЧНО: Автоматически отправляем голос сразу при получении предложения
        const vote: MigrationVotePayload = {
          voterId: myPlayerId.value,
          voterToken: myPlayer.value?.authToken || '',
          proposedHostId: payload.proposedHostId,
          vote: 'approve',
          timestamp: Date.now()
        }

        console.log('🗳️ SENDING MIGRATION VOTE:', {
          vote,
          targetPeer: payload.proposedHostId,
          hasConnection: peerService.hasConnection(payload.proposedHostId),
          allConnections: peerService.getActiveConnections()
        })

        peerService.sendMessage(
          payload.proposedHostId,
          makeMessage(
            'migration_vote',
            vote,
            { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
          )
        )

        console.log('✅ Migration vote sent successfully')
      } else {
        console.log('❌ Migration proposal validation failed:', {
          proposedHostExists: !!gameState.value.players.find(p => p.id === payload.proposedHostId),
          tokenMatch: gameState.value.players.find(p => p.id === payload.proposedHostId)?.authToken === payload.proposedHostToken
        })
      }
    })

    peerService.onMessage('migration_vote', (message) => {
      const payload = message.payload as MigrationVotePayload
      console.log('Received migration vote:', payload)

      if (validateMigrationVote(payload)) {
        migrationState.value.votes.set(payload.voterId, payload.vote)
        checkMigrationConsensus()
      }
    })

    peerService.onMessage('migration_confirmed', (message) => {
      const payload = message.payload as MigrationConfirmedPayload
      console.log('Received migration confirmation:', payload)

      if (validateMigrationConfirmation(payload)) {
        executeMigration(payload.newHostId)
      }
    })

    peerService.onMessage('new_host_id', (message) => {
      const payload = message.payload as NewHostIdPayload
      console.log('Received new host ID:', payload)

      if (payload.oldHostId === migrationState.value.proposedHostId) {
        finalizeHostMigration(payload.newHostId)
      }
    })
  }

  // Ожидание голосов
  const waitForMigrationVotes = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const requiredVotes = gameState.value.players.length
        const receivedVotes = migrationState.value.votes.size

        if (receivedVotes >= requiredVotes) {
          clearInterval(checkInterval)
          checkMigrationConsensus()
          resolve()
        }
      }, 100)

      // Таймаут для безопасности
      setTimeout(() => {
        clearInterval(checkInterval)
        reject(new Error('Migration vote timeout'))
      }, VOTE_TIMEOUT + 1000)
    })
  }

  // Проверка консенсуса
  const checkMigrationConsensus = () => {
    const totalVotes = migrationState.value.votes.size
    const approveVotes = Array.from(migrationState.value.votes.values()).filter(v => v === 'approve').length

    console.log(`Migration votes: ${approveVotes}/${totalVotes} approve`)

    // Требуем единогласного одобрения для безопасности
    if (approveVotes === totalVotes && totalVotes === gameState.value.players.length) {
      confirmMigration()
    }
  }

  // Подтверждение миграции
  const confirmMigration = async () => {
    console.log('Migration approved by all players')

    if (migrationState.value.timeout) {
      clearTimeout(migrationState.value.timeout)
    }

    migrationState.value.phase = 'confirmed'

    const confirmation: MigrationConfirmedPayload = {
      newHostId: migrationState.value.proposedHostId!,
      newHostToken: myPlayer.value?.authToken || '',
      confirmedBy: Array.from(migrationState.value.votes.keys()),
      timestamp: Date.now()
    }

    // Рассылаем подтверждение
    peerService.broadcastMessage(
      makeMessage(
        'migration_confirmed',
        confirmation,
        { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
      )
    )

    // Выполняем миграцию
    await executeMigration(migrationState.value.proposedHostId!)
  }

  // Выполнение миграции
  const executeMigration = async (newHostId: string) => {
    console.log('Executing migration to new host:', newHostId)

    if (newHostId === myPlayerId.value) {
      // Я становлюсь новым хостом
      await becomeNewHostSecurely()
    } else {
      // Ожидаю новый ID от хоста и переподключаюсь
      console.log('Waiting for new host ID...')
    }
  }

  // Безопасное становление новым хостом
  const becomeNewHostSecurely = async () => {
    console.log('Becoming new host securely...')

    const oldId = myPlayerId.value

    // Обновляем локальное состояние
    isHost.value = true
    hostId.value = myPlayerId.value
    gameState.value.hostId = myPlayerId.value

    // Обновляем роль игрока в списке
    const myPlayerIndex = gameState.value.players.findIndex((p: Player) => p.id === myPlayerId.value)
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].isHost = true
    }

    // КРИТИЧНО: Передаем roomId для сохранения нового peer ID хоста
    // Если по какой-то причине roomId пуст — пробуем взять устойчивый
    if (!roomId.value) {
      roomId.value = loadPersistentRoomId() || ''
    }
    const newPeerId = await peerService.createHost(roomId.value)

    // Уведомляем всех о новом ID
    // BUGFIX: отправляем сначала new_host_id через старые соединения, а затем обновляем локальные ID
    const newHostMessage: NewHostIdPayload = {
      oldHostId: oldId,
      newHostId: newPeerId,
      newHostToken: myPlayer.value?.authToken || '',
      timestamp: Date.now()
    }

    // Отправляем через старые соединения перед их закрытием
    peerService.broadcastMessage(
      makeMessage(
        'new_host_id',
        newHostMessage,
        { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
      )
    )

    // Обновляем состояние
    myPlayerId.value = newPeerId
    gameState.value.hostId = newPeerId

    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].id = newPeerId
    }

    // Запускаем heartbeat (убраны дубли)
    peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)

    // Настраиваем обработчики для хоста
    setupHostMessageHandlers()

    console.log('Successfully became new host with ID:', newPeerId)

    resetMigrationState()
  }

  // Финализация миграции хоста
  const finalizeHostMigration = async (newHostId: string) => {
    console.log('Finalizing host migration to:', newHostId)

    try {
      connectionStatus.value = 'connecting'

      // Переподключаемся к новому хосту
      await peerService.reconnectToNewHost(newHostId)

      hostId.value = newHostId
      gameState.value.hostId = newHostId

      // Устанавливаем роль клиента
      peerService.setAsClient()

      // Настраиваем обработчики для клиента
      setupClientMessageHandlers()

      // Запрашиваем актуальное состояние игры (убрали дублирующий вызов)
      peerService.sendMessage(
        newHostId,
        makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      connectionStatus.value = 'connected'
      console.log('Successfully migrated to new host')

      resetMigrationState()
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to finalize migration:', error.message)
      } else {
        console.error('Failed to finalize migration: Unknown error')
      }
      connectionStatus.value = 'disconnected'
      resetMigrationState()
    }
  }

  // Валидация предложения миграции
  const validateMigrationProposal = (payload: MigrationProposalPayload): boolean => {
    // Проверяем, что предложенный хост есть в списке игроков
    const proposedPlayer = gameState.value.players.find(p => p.id === payload.proposedHostId)
    return !!(proposedPlayer && proposedPlayer.authToken === payload.proposedHostToken)
  }

  // Валидация голоса
  const validateMigrationVote = (payload: MigrationVotePayload): boolean => {
    const voter = gameState.value.players.find(p => p.id === payload.voterId)
    return !!(voter && voter.authToken === payload.voterToken)
  }

  // Валидация подтверждения
  const validateMigrationConfirmation = (payload: MigrationConfirmedPayload): boolean => {
    // Проверяем, что все подтвердившие игроки валидны
    return payload.confirmedBy.every(playerId =>
      gameState.value.players.some(p => p.id === playerId && validateAuthToken(p))
    )
  }

  // Сброс состояния миграции
  const resetMigrationState = () => {
    if (migrationState.value.timeout) {
      clearTimeout(migrationState.value.timeout)
    }

    migrationState.value.inProgress = false
    migrationState.value.phase = null
    migrationState.value.proposedHostId = null
    migrationState.value.votes.clear()
    migrationState.value.timeout = null

    console.log('Migration state reset')
  }

  // Обработка таймаута миграции
  const handleMigrationTimeout = () => {
    console.log('Migration timeout occurred')
    resetMigrationState()
    connectionStatus.value = 'disconnected'
  }

  // Принудительное завершение миграции (backup mechanism)
  const forceMigrationComplete = async () => {
    console.log('🚨 Force migration complete - emergency takeover')

    try {
      // Сбрасываем состояние миграции
      resetMigrationState()

      // Принудительно становимся хостом
      await becomeNewHost()

      console.log('🚨 Emergency migration completed successfully')
    } catch (error) {
      console.error('🚨 Emergency migration failed:', error)
      connectionStatus.value = 'disconnected'
    }
  }

  // Детерминированный выбор хоста без голосования (fallback)
  const electHostDeterministic = (validPlayers: Player[]): string => {
    // Новый критерий: минимальный players[i].id (peerId)
    const sortedPlayers = validPlayers
      .slice()
      .sort((a: Player, b: Player) => a.id.localeCompare(b.id))

    if (sortedPlayers.length === 0) {
      throw new Error('No valid players for deterministic host election')
    }

    const deterministicHostId = sortedPlayers[0].id
    console.log('Deterministic host elected by min id:', deterministicHostId, {
      selectedNickname: sortedPlayers[0].nickname
    })

    return deterministicHostId
  }

  // Детерминированный алгоритм выборов нового хоста
  const electNewHost = (): string => {
    // Критерий подтвержден: минимальный players[i].id
    const remainingPlayers = gameState.value.players
      .filter((p: Player) => p.id !== (gameState.value.hostId || ''))
      .sort((a: Player, b: Player) => a.id.localeCompare(b.id))

    if (remainingPlayers.length === 0) {
      throw new Error('No remaining players for host election')
    }

    const newHostId = remainingPlayers[0].id
    console.log('New host elected by min id:', newHostId)

    return newHostId
  }

  // Становлюсь новым хостом
  const becomeNewHost = async () => {
    console.log('Becoming new host...')

    // Обновляем локальное состояние
    isHost.value = true
    hostId.value = myPlayerId.value
    gameState.value.hostId = myPlayerId.value

    // Обновляем роль игрока в списке
    const myPlayerIndex = gameState.value.players.findIndex((p: Player) => p.id === myPlayerId.value)
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].isHost = true
    }

    // КРИТИЧНО: Передаем roomId для сохранения нового peer ID хоста
    const newPeerId = await peerService.createHost(roomId.value)
    myPlayerId.value = newPeerId
    gameState.value.hostId = newPeerId

    // Обновляем свой ID в списке игроков
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].id = newPeerId
    }

    // Запускаем heartbeat
    peerService.setAsHost(newPeerId)

    // Настраиваем обработчики для хоста
    setupHostMessageHandlers()

    console.log('Successfully became new host with ID:', newPeerId)

    // Уведомляем всех о смене хоста
    broadcastHostMigration(newPeerId)
  }

  // Становлюсь новым хостом с учетом восстановления после grace period
  const becomeNewHostWithRecovery = async (originalHostId: string) => {
    console.log('🏁 Becoming new host with recovery context, original host was:', originalHostId)

    try {
      // Обновляем локальное состояние
      isHost.value = true
      hostId.value = myPlayerId.value
      gameState.value.hostId = myPlayerId.value

      // Обновляем роль игрока в списке
      const myPlayerIndex = gameState.value.players.findIndex((p: Player) => p.id === myPlayerId.value)
      if (myPlayerIndex !== -1) {
        gameState.value.players[myPlayerIndex].isHost = true
      }

      // КРИТИЧНО: Передаем roomId для сохранения нового peer ID хоста
      if (!roomId.value) {
        roomId.value = loadPersistentRoomId() || ''
      }
      const newPeerId = await peerService.createHost(roomId.value)
      myPlayerId.value = newPeerId
      gameState.value.hostId = newPeerId

      // Обновляем свой ID в списке игроков
      if (myPlayerIndex !== -1) {
        gameState.value.players[myPlayerIndex].id = newPeerId
      }

      // Запускаем heartbeat
      peerService.setAsHost(newPeerId)

      // Настраиваем обработчики для хоста
      setupHostMessageHandlers()

      console.log('🎉 Successfully became new host with recovery, new ID:', newPeerId)

      // Отправляем специальное уведомление о восстановлении хоста
      const recoveryAnnouncement: HostRecoveryAnnouncementPayload = {
        originalHostId,
        recoveredHostId: newPeerId,
        roomId: gameState.value.roomId,
        gameState: gameState.value,
        recoveryTimestamp: Date.now(),
        meshTopology: peerService.getAllKnownPeers()
      }

      // Ждем немного перед отправкой уведомления для стабилизации соединения
      setTimeout(() => {
        peerService.broadcastToAllPeers(
          makeMessage(
            'host_recovery_announcement',
            recoveryAnnouncement,
            { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
          )
        )

        console.log('📢 Sent host recovery announcement to all peers')
      }, MESH_RESTORATION_DELAY)

      // Также рассылаем обычное уведомление о смене хоста для совместимости
      broadcastHostMigration(newPeerId)

      connectionStatus.value = 'connected'

    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to finalize migration:', error.message)
      } else {
        console.error('Failed to finalize migration: Unknown error')
      }
      connectionStatus.value = 'disconnected'
      resetMigrationState()
    }
  }

  // Переподключение к новому хосту
  const reconnectToNewHost = async (newHostId: string) => {
    console.log('Reconnecting to new host:', newHostId)

    // Если детерминированный кандидат определен и этот клиент не он — не инициируем emergency takeover
    if (newHostId && newHostId !== myPlayerId.value) {
      migrationState.value.emergencyLock = true
    }

    connectionStatus.value = 'connecting'

    try {
      // Переподключаемся к новому хосту
      await peerService.reconnectToNewHost(newHostId)

      hostId.value = newHostId
      gameState.value.hostId = newHostId

      // Устанавливаем роль клиента
      peerService.setAsClient()

      // Настраиваем обработчики для клиента
      setupClientMessageHandlers()

      // Запрашиваем актуальное состояние игры
      peerService.sendMessage(
        newHostId,
        makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      connectionStatus.value = 'connected'
      console.log('Successfully reconnected to new host')
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to reconnect to new host:', error.message)
      } else {
        console.error('Failed to reconnect to new host: Unknown error')
      }
      connectionStatus.value = 'disconnected'
      throw error as any
    }
  }

  // Уведомление о смене хоста
  const broadcastHostMigration = (newHostId: string) => {
    const migrationMessage = makeMessage(
      'host_migration_started',
      {
        newHostId,
        reason: 'host_disconnected'
      },
      { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
    )

    peerService.broadcastMessage(migrationMessage)
  }


  // Сохранение расширенной сессии в localStorage
  // Новая схема: отказ от отдельного SESSION_STORAGE_KEY.
  // Атомарные поля будут сохраняться через Pinia persist; расширенную сессию больше не пишем.
  const saveSession = () => {
    return
  }

  // Загрузка сессии из localStorage
  // Сессии больше не читаем из отдельного ключа; опираемся на гидратацию Pinia и anchorSnapshot.
  const loadSession = (): SessionData | null => {
    return null
  }

  // Удаление сессии
  const clearSession = () => {
    // no-op: отдельного ключа сессии больше нет
    console.log('Session cleared (no-op)')
  }

  // Универсальное восстановление состояния из сохраненной сессии
  const restoreSession = async (): Promise<boolean> => {
    const ridGuard = startRequest('restoreSession')

    // Читаем якорный снапшот (если есть и свежий)
    let anchorState: GameState | null = null
    try {
      const cached = storageSafe.getWithTTL<{ ts: number, state: GameState }>('game', 'hostGameStateSnapshot', null)
      if (cached?.state) {
        anchorState = cached.state
        console.log('Using cached host snapshot as anchor for restore')
      }
    } catch (e) {
      console.warn('Failed to read host snapshot from storageSafe', e)
    }

    // Если ни снапшота, ни атомарных полей — это не фатально, продолжим c текущим state (иниц. пустой)
    try {
      console.log('Attempting to restore session...')
      restorationState.value = 'discovering'
      connectionStatus.value = 'connecting'

      // Если есть якорь – применим его как стартовое состояние
      if (anchorState) {
        gameState.value = { ...anchorState }
        if ((gameState.value.phase ?? 'lobby') !== 'lobby') {
          gameState.value.gameStarted = true
        }
      }

      // Универсальный discovery: используем атомарные поля из стора (гидратированы плагином)
      const sessionDataLike = {
        myPlayerId: myPlayerId.value,
        myNickname: myNickname.value,
        isHost: isHost.value,
        hostId: hostId.value,
        roomId: roomId.value,
        gameState: gameState.value
      } as SessionData

      console.log('Starting universal host discovery...')
      const currentHost = await universalHostDiscovery(sessionDataLike)

      restorationState.value = 'restoring'

      if (currentHost) {
        console.log('Found active host, connecting as client:', currentHost.currentHostId)
        // Найден активный хост - подключаемся как клиент
        isHost.value = false
        hostId.value = currentHost.currentHostId
        await restoreAsClient(currentHost.currentHostId)
      } else {
        // Если discovery никого не нашёл, проверим: действительно ли мы были хостом
        // Хост подтверждён, только если sessionData.isHost === true И anchorState.hostId === myPlayerId
        const canBeHost = !!(isHost.value && (gameState.value.hostId === myPlayerId.value || !gameState.value.hostId))
        if (canBeHost) {
          console.log('No active host found, becoming host (confirmed by anchor/pinia)...')
          isHost.value = true
          await restoreAsHost()
        } else {
          console.log('No active host found and no authority to self-promote, retrying quick discovery...')
          isHost.value = false
          hostId.value = ''
          const retryHost = await universalHostDiscovery({
            myPlayerId: myPlayerId.value,
            myNickname: myNickname.value,
            isHost: false,
            hostId: hostId.value,
            roomId: roomId.value,
            gameState: gameState.value
          } as any)
          if (retryHost) {
            hostId.value = retryHost.currentHostId
            await restoreAsClient(retryHost.currentHostId)
          } else {
            connectionStatus.value = 'disconnected'
            restorationState.value = 'idle'
            console.log('Staying disconnected: no authoritative host and not confirmed host self-promotion')
            return false
          }
        }
      }

      // Успех восстановления только после подтверждённого подключения и получения состояния
      restorationState.value = 'idle'
      if (!gameState.value || !gameState.value.players || gameState.value.players.length === 0) {
        console.log('Session restore finished, but no valid state received — staying disconnected')
        connectionStatus.value = 'disconnected'
        endRequestError('restoreSession', ridGuard, normalizeError('State not synced', 'restore_state_missing'))
        return false
      }
      connectionStatus.value = 'connected'
      console.log('Session successfully restored (validated by state)')
      sessionTimestamp.value = Date.now()
      endRequestSuccess('restoreSession', ridGuard)
      return true
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to restore session:', error.message)
      } else {
        console.error('Failed to restore session: Unknown error')
      }
      restorationState.value = 'idle'
      connectionStatus.value = 'disconnected'
      endRequestError('restoreSession', ridGuard, normalizeError(error, 'restore_failed'))
      clearSession()
      return false
    }
  }

  // Дет-выбор кандидата по минимальному players[].id
  // (удалено: дублировало реализацию ниже)

  // Универсальный опрос для обнаружения текущего хоста (более агрессивная стратегия)
  // Локальный блэклист недоступных кандидатов в рамках одной операции discovery
  function createCandidateBlacklist() {
    const set = new Set<string>()
    return {
      add: (id: string) => set.add(id),
      has: (id: string) => set.has(id)
    }
  }

  const universalHostDiscovery = async (sessionData: SessionData): Promise<HostDiscoveryResponsePayload | null> => {
    console.log('Starting universal host discovery...')

    const blacklist = createCandidateBlacklist()

    // Стратегия 1: Попытка подключения к последнему известному хосту (с валидацией достижимости)
    if (sessionData.hostId && sessionData.hostId !== sessionData.myPlayerId) {
      console.log('Strategy 1: Trying to connect to last known host (validate reachability):', sessionData.hostId)
      const lastKnownHost = await tryConnectToKnownHost(sessionData.hostId)
      if (lastKnownHost) {
        console.log('Last known host is still active:', sessionData.hostId)
        return lastKnownHost
      } else {
        console.log('Last known host unreachable, blacklisting:', sessionData.hostId)
        blacklist.add(sessionData.hostId)
      }
    }

    // Стратегия 2: Опрос всех сохраненных игроков
    const savedPlayers = sessionData.gameState.players.filter((p: Player) => !p.isHost && p.id !== sessionData.myPlayerId)
    if (savedPlayers.length > 0) {
      console.log('Strategy 2: Polling saved players:', savedPlayers.map((p: Player) => p.id))
      const discoveredFromPlayers = await quickHostDiscovery(savedPlayers)
      if (discoveredFromPlayers) {
        return discoveredFromPlayers
      }
      // Добавим всех недоступных из savedPlayers в блэклист по месту (quickHostDiscovery сам очищает свои временные коннекты;
      // если хоста не нашли, значит ни один не подтвердил себя как хост)
      savedPlayers.forEach(p => blacklist.add(p.id))
    }

    // Стратегия 3: Детерминированный кандидат по минимальному id среди АКТУАЛЬНЫХ игроков,
    // НО только если он достижим (короткая проверка доступности)
    const nonHostPlayers = (gameState.value.players || []).filter(p => !!p && p.id && p.id !== sessionData.myPlayerId)
    const sortedById = [...nonHostPlayers].sort((a, b) => a.id.localeCompare(b.id))

    for (const candidate of sortedById) {
      if (blacklist.has(candidate.id)) {
        console.log('Skip blacklisted deterministic candidate:', candidate.id)
        continue
      }
      console.log('Universal host discovery fallback trying deterministic candidate (reachability check):', candidate.id)
      const reachable = await tryConnectToKnownHost(candidate.id)
      if (reachable) {
        console.log('Deterministic candidate reachable, selecting as host:', candidate.id)
        return {
          responderId: candidate.id,
          responderToken: candidate.authToken || '',
          isHost: false,
          currentHostId: candidate.id,
          gameState: gameState.value,
          timestamp: Date.now()
        } as any
      } else {
        console.log('Deterministic candidate NOT reachable, blacklisting:', candidate.id)
        blacklist.add(candidate.id)
      }
    }

    console.log('Universal host discovery failed - no active host found')
    return null
  }

  // Обнаружение активной сети для существующей комнаты
  const discoverActiveNetwork = async (sessionData: SessionData): Promise<HostDiscoveryResponsePayload | null> => {
    console.log('Discovering active network for room:', sessionData.roomId)

    // Используем тот же алгоритм что и в universalHostDiscovery
    return await universalHostDiscovery(sessionData)
  }

  // Попытка подключения к известному хосту
  // Проверка достижимости конкретного peer как хоста.
  // ВАЖНО: используем существующий peer, если он уже создан, чтобы избежать гонок и множественных временных peer'ов.
  const tryConnectToKnownHost = async (hostId: string): Promise<HostDiscoveryResponsePayload | null> => {
    return new Promise(async (resolve) => {
      try {
        console.log('Trying to connect to known host (with reachability validation):', hostId)
        const mainPeer = peerService.getPeer()

        const doTempCheck = async () => {
          const tempPeer = new (await import('peerjs')).default()
          tempPeer.on('open', (tempId) => {
            const conn = tempPeer.connect(hostId)
            const timeout = setTimeout(() => {
              try { conn.close() } catch {}
              try { tempPeer.destroy() } catch {}
              resolve(null)
            }, 2000)
            conn.on('open', () => {
              conn.send({
                type: 'host_discovery_request',
                payload: {
                  requesterId: tempId,
                  requesterToken: myPlayer.value?.authToken || '',
                  timestamp: Date.now()
                }
              })
            })
            conn.on('data', (data: any) => {
              const message = data as PeerMessage
              if (message.type === 'host_discovery_response') {
                const response = message.payload as HostDiscoveryResponsePayload
                clearTimeout(timeout)
                try { conn.close() } catch {}
                try { tempPeer.destroy() } catch {}
                if (response.isHost) {
                  resolve(response)
                } else {
                  resolve(null)
                }
              }
            })
            conn.on('error', () => {
              clearTimeout(timeout)
              try { tempPeer.destroy() } catch {}
              resolve(null)
            })
          })
          tempPeer.on('error', () => resolve(null))
        }

        if (!mainPeer || !mainPeer.open) {
          // Нет основного peer — используем временный
          await doTempCheck()
          return
        }

        // Используем основной peer для запроса
        const conn = mainPeer.connect(hostId)
        const timeout = setTimeout(() => {
          try { conn.close() } catch {}
          resolve(null)
        }, 2000)

        conn.on('open', () => {
          conn.send({
            type: 'host_discovery_request',
            payload: {
              requesterId: mainPeer.id,
              requesterToken: myPlayer.value?.authToken || '',
              timestamp: Date.now()
            }
          })
        })

        conn.on('data', (data: any) => {
          const message = data as PeerMessage
          if (message.type === 'host_discovery_response') {
            const response = message.payload as HostDiscoveryResponsePayload
            clearTimeout(timeout)
            try { conn.close() } catch {}
            if (response.isHost) {
              resolve(response)
            } else {
              resolve(null)
            }
          }
        })

        conn.on('error', () => {
          clearTimeout(timeout)
          resolve(null)
        })
      } catch (error) {
        console.log('Failed to connect to known host:', error)
        resolve(null)
      }
    })
  }

  // Добавляем обработчик host discovery к существующим обработчикам
  const setupHostDiscoveryHandlers = () => {
    peerService.onMessage('host_discovery_request', (message, conn) => {
      if (!conn) return

      const request = (message as Extract<PeerMessage, { type: 'host_discovery_request' }>).payload
      console.log('Received host discovery request:', request)

      const response: HostDiscoveryResponsePayload = {
        responderId: myPlayerId.value,
        responderToken: myPlayer.value?.authToken || '',
        isHost: isHost.value,
        currentHostId: gameState.value.hostId,
        gameState: gameState.value,
        timestamp: Date.now()
      }

      // Отправляем ответ c корректным сообщением протокола
      conn.send(
        makeMessage(
          'host_discovery_response',
          response,
          { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      console.log('Sent host discovery response:', response)
    })
  }

  // Настройка mesh-протокола для P2P соединений между всеми игроками
  const setupMeshProtocolHandlers = () => {
    console.log('Setting up mesh protocol handlers')

    // Обработка запроса списка peer'ов
    peerService.onMessage('request_peer_list', (message, conn) => {
      if (!conn) return

      const request = (message as Extract<PeerMessage, { type: 'request_peer_list' }>).payload
      console.log('Received peer list request:', request)

      // Отправляем список всех игроков запросившему
      const peerListUpdate: PeerListUpdatePayload = {
        peers: gameState.value.players,
        fromPlayerId: myPlayerId.value,
        timestamp: Date.now()
      }

      conn.send(
        makeMessage(
          'peer_list_update',
          peerListUpdate,
          { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      console.log('Sent peer list to:', request.requesterId, 'players:', gameState.value.players.length)
    })

    // Обработка обновления списка peer'ов
    peerService.onMessage('peer_list_update', async (message) => {
      const update = (message as Extract<PeerMessage, { type: 'peer_list_update' }>).payload
      console.log('🔗 Received peer list update:', update)

      // Добавляем всех peer'ов в известные
      const peerIds = update.peers.map((p: Player) => p.id)
      console.log('📋 All peer IDs from update:', peerIds)
      console.log('🔍 My player ID:', myPlayerId.value)
      console.log('📤 From player ID:', update.fromPlayerId)

      peerService.addKnownPeers(peerIds)

      // ИСПРАВЛЕНО: Подключаемся ко ВСЕМ другим игрокам (истинная mesh-топология)
      const peersToConnect = peerIds.filter(id =>
        id !== myPlayerId.value  // Исключаем только себя, НЕ исключаем хоста!
      )

      console.log('🔌 Peers to connect to:', peersToConnect)
      console.log('📊 Current active connections before mesh:', peerService.getActiveConnections())

      if (peersToConnect.length > 0) {
        console.log('🚀 Attempting mesh connections to:', peersToConnect)
        await peerService.connectToAllPeers(peersToConnect)

        // Проверяем результат
        console.log('✅ Active connections after mesh attempt:', peerService.getActiveConnections())
      } else {
        console.log('❌ No peers to connect to for mesh network')
      }
    })

    // Обработка запроса прямого соединения
    peerService.onMessage('direct_connection_request', (message, conn) => {
      if (!conn) return

      const request = (message as Extract<PeerMessage, { type: 'direct_connection_request' }>).payload
      console.log('Received direct connection request:', request)

      // Добавляем peer'а в известные
      peerService.addKnownPeer(request.requesterId)

      // Соединение уже установлено через conn, просто логируем
      console.log('Direct connection established with:', request.requesterId)
    })

    // Обработка синхронизации состояния
    peerService.onMessage('state_sync', (message) => {
      const sync = (message as Extract<PeerMessage, { type: 'state_sync' }>).payload
      console.log('Received state sync:', sync)

      // Если получили более свежее состояние игры - обновляем
      if (sync.timestamp > gameState.value.createdAt) {
        console.log('Updating to newer game state from:', sync.fromPlayerId)
        gameState.value = {...sync.gameState}
      }
    })

    // Обработка выборов нового хоста
    peerService.onMessage('new_host_election', (message) => {
      const election = (message as Extract<PeerMessage, { type: 'new_host_election' }>).payload
      console.log('Received host election:', election)

      // Проверяем валидность кандидата
      const candidate = gameState.value.players.find((p: Player) => p.id === election.candidateId)
      if (candidate && candidate.authToken === election.candidateToken) {
        // Обновляем хоста если консенсус достигнут
        const totalPlayers: number = gameState.value.players.length
        const supportingPlayers: number = election.electorsConsensus.length

        if (supportingPlayers >= Math.ceil(totalPlayers / 2)) {
          console.log('Host election successful, new host:', election.candidateId)

          gameState.value.hostId = election.candidateId
          hostId.value = election.candidateId

          // Если я не новый хост - становлюсь клиентом
          if (election.candidateId !== myPlayerId.value) {
            isHost.value = false
          }
        }
      }
    })

    // Обработка объявлений о восстановлении хоста
    peerService.onMessage('host_recovery_announcement', (message) => {
      const announcement = (message as Extract<PeerMessage, { type: 'host_recovery_announcement' }>).payload
      console.log('🎊 Received host recovery announcement:', announcement)

      // Отменяем любые идущие процедуры миграции
      if (migrationState.value.inProgress) {
        console.log('🛑 Cancelling migration due to host recovery')
        resetMigrationState()
      }

      // Отменяем grace period если он активен
      if (peerService.isInHostRecoveryGracePeriod()) {
        console.log('🛑 Cancelling grace period due to host recovery')
        peerService.cancelHostRecoveryGracePeriod()
      }

      // Обновляем состояние игры с восстановленного хоста
      gameState.value = {...announcement.gameState}
      hostId.value = announcement.recoveredHostId

      // Если я не восстановленный хост - становлюсь клиентом
      if (announcement.recoveredHostId !== myPlayerId.value) {
        isHost.value = false

        // Пытаемся переподключиться к восстановленному хосту
        setTimeout(async () => {
          try {
            console.log('🔄 Reconnecting to recovered host:', announcement.recoveredHostId)
            await reconnectToNewHost(announcement.recoveredHostId)
            console.log('✅ Successfully reconnected to recovered host')
          } catch (error: unknown) {
            if (error instanceof Error) {
              console.error('❌ Failed to reconnect to recovered host:', error.message)
            } else {
              console.error('❌ Failed to reconnect to recovered host: Unknown error')
            }
          }
        }, MESH_RESTORATION_DELAY)
      }

      connectionStatus.value = 'connected'
      console.log('🎉 Host recovery announcement processed successfully')
    })
  }

  // Вспомогательная функция для идемпотентной отправки с ретраями (экспоненциальная задержка)
  const gotFreshState = ref(false)
  async function sendWithRetry(
    targetId: string,
    buildMessage: () => PeerMessage,
    maxAttempts = 3,
    baseDelayMs = 300,
    stopOnStateUpdate = true
  ): Promise<void> {
    let attempt = 0
    while (attempt < maxAttempts) {
      attempt++
      try {
        peerService.sendMessage(targetId, buildMessage())
      } catch {}
      if (stopOnStateUpdate && gotFreshState.value) {
        return
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1)
      await new Promise(r => setTimeout(r, delay))
      if (stopOnStateUpdate && gotFreshState.value) {
        return
      }
    }
  }

  // Восстановление хоста
  const restoreAsHost = async () => {
    console.log('Restoring as host...')

    // Если фаза не лобби — убеждаемся, что флаг запущенности установлен
    if ((gameState.value.phase ?? 'lobby') !== 'lobby') {
      gameState.value.gameStarted = true
    }

    // Перед любыми рассылками синхронизируем phase/gameMode с локальными рефами
    if (gameState.value.phase) {
      gamePhase.value = gameState.value.phase as any
    }
    if (gameState.value.gameMode) {
      gameMode.value = gameState.value.gameMode as any
    }

    // КРИТИЧНО: Передаем roomId для восстановления сохраненного peer ID
    if (!roomId.value) {
      roomId.value = loadPersistentRoomId() || gameState.value.roomId || ''
    }
    // 1) Стартуем восстановление Peer с попыткой сохранить прежний hostId для этой комнаты
    const newPeerId = await peerService.createHost(roomId.value)

    // 2) Определяем старый hostId и фиксируем новый
    const oldHostId = gameState.value.hostId || myPlayerId.value
    myPlayerId.value = newPeerId
    hostId.value = newPeerId
    gameState.value.hostId = newPeerId

    // 2.1) Если в players ещё нет записи для нового ID — делаем ремап старого hostId->newPeerId
    try {
      const existingWithNew = gameState.value.players.find(p => p.id === newPeerId)
      if (!existingWithNew && oldHostId && oldHostId !== newPeerId) {
        const idx = gameState.value.players.findIndex(p => p.id === oldHostId)
        if (idx !== -1) {
          gameState.value.players[idx].id = newPeerId
          gameState.value.players[idx].isHost = true
        } else {
          // на всякий случай добавим хоста, если по какой-то причине он отсутствует в players
          gameState.value.players.push({
            id: newPeerId,
            nickname: myNickname.value || generateDefaultNickname(),
            color: getColorByIndex(0),
            isHost: true,
            joinedAt: Date.now(),
            authToken: generateAuthToken(newPeerId, roomId.value || gameState.value.roomId, Date.now()),
            votingCards: ['Голос 1', 'Голос 2'],
            bettingCards: ['0', '±', '+']
          } as any)
        }

        // Ремап ссылок в состоянии на хоста
        if (gameState.value.litUpPlayerId === oldHostId) gameState.value.litUpPlayerId = newPeerId
        if (gameState.value.currentTurnPlayerId === oldHostId) gameState.value.currentTurnPlayerId = newPeerId

        if (gameState.value.votes) {
          const newVotes: Record<string, string[]> = {}
          Object.entries(gameState.value.votes).forEach(([k, v]) => {
            const mappedKey = k === oldHostId ? newPeerId : k
            const mappedArray = (v || []).map(t => (t === oldHostId ? newPeerId : t))
            newVotes[mappedKey] = mappedArray
          })
          gameState.value.votes = newVotes
        }
        if (gameState.value.voteCounts) {
          const newCounts: Record<string, number> = {}
          Object.entries(gameState.value.voteCounts).forEach(([k, v]) => {
            const mappedKey = k === oldHostId ? newPeerId : k
            newCounts[mappedKey] = v
          })
          gameState.value.voteCounts = newCounts
        }
        if (gameState.value.bets) {
          const newBets: Record<string, '0' | '±' | '+'> = {}
          Object.entries(gameState.value.bets).forEach(([k, v]) => {
            const mappedKey = k === oldHostId ? newPeerId : k
            newBets[mappedKey] = v as any
          })
          gameState.value.bets = newBets
        }
        if (gameState.value.guesses) {
          const newGuesses: Record<string, string> = {}
          Object.entries(gameState.value.guesses).forEach(([k, v]) => {
            const mappedKey = k === oldHostId ? newPeerId : k
            const mappedVal = v === oldHostId ? newPeerId : v
            newGuesses[mappedKey] = mappedVal
          })
          gameState.value.guesses = newGuesses
        }
        if (gameState.value.scores) {
          const newScores: Record<string, number> = {}
          Object.entries(gameState.value.scores).forEach(([k, v]) => {
            const mappedKey = k === oldHostId ? newPeerId : k
            newScores[mappedKey] = v
          })
          gameState.value.scores = newScores
        }
        if (gameState.value.roundScores) {
          const newRoundScores: Record<string, number> = {}
          Object.entries(gameState.value.roundScores).forEach(([k, v]) => {
            const mappedKey = k === oldHostId ? newPeerId : k
            newRoundScores[mappedKey] = v
          })
          gameState.value.roundScores = newRoundScores
        }
        if (Array.isArray(gameState.value.roundWinners) && gameState.value.roundWinners.length > 0) {
          gameState.value.roundWinners = gameState.value.roundWinners.map(pid => (pid === oldHostId ? newPeerId : pid))
        }
        if (gameState.value.answeringPlayerId === oldHostId) {
          gameState.value.answeringPlayerId = newPeerId
        }
      }
    } catch (e) {
      console.warn('Host ID remap during restoreAsHost failed (non-critical):', e)
    }

    // Обновляем свой ID в списке игроков
      const myPlayerIndex = gameState.value.players.findIndex((p: Player) => p.id === oldHostId)
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].id = newPeerId
    }

    // 3) Устанавливаем роль хоста и запускаем heartbeat
    peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)

    // 3.1) Восстанавливаем handlers и mesh, чтобы клиенты могли быстро нас обнаружить
    setupHostMessageHandlers()
    setupMeshProtocolHandlers()

    // 4) Немедленно шлем консистентный снапшот и объявление восстановления,
    // чтобы клиенты заякорились, а претенденты на миграцию отменили takeover
    broadcastGameState()
    try {
      peerService.broadcastMessage(
        makeMessage(
          'host_recovery_announcement',
          {
            recoveredHostId: newPeerId,
            gameState: { ...gameState.value }
          } as HostRecoveryAnnouncementPayload,
          { roomId: roomId.value || gameState.value.roomId, fromId: newPeerId, ts: Date.now() }
        )
      )
    } catch {}

    // Отправим также краткий 'new_host_id' как fallback для клиентов, которые пропускают announcement
    try {
      broadcastNewHostId(newPeerId)
    } catch {}
    // Также положим снапшот в storageSafe с TTL как якорь для быстрых reload клиентов
    try {
      storageSafe.setWithTTL(
        'game',
        'hostGameStateSnapshot',
        { ts: Date.now(), state: { ...gameState.value } },
        HOST_SNAPSHOT_TTL
      )
      // Дополнительно сохраняем устойчивый roomId для дальнейших рестартов
      if (roomId.value) savePersistentRoomId(roomId.value)
    } catch {}

    console.log('Host restored with ID (may be same as before):', newPeerId)
  }

  // Восстановление клиента
  const restoreAsClient = async (targetHostId: string) => {
    console.log('Restoring as client, connecting to:', targetHostId)

    try {
      // Если фаза не лобби — устанавливаем gameStarted для предотвращения UI отката в лобби до синхронизации
      if ((gameState.value.phase ?? 'lobby') !== 'lobby') {
        gameState.value.gameStarted = true
      }

      // Устанавливаем контекст комнаты ДО любых сетевых действий
      peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)

      // Флаг свежего состояния
      gotFreshState.value = false

      // ИСПРАВЛЕНО: НЕ очищаем litUpPlayerId сразу, дождемся актуального состояния
      console.log('Keeping current litUpPlayerId until state sync:', gameState.value.litUpPlayerId)

      // Сохраняем старый ID ПЕРЕД его перезаписью (из стора или из устойчивого хранилища)
      const originalPlayerId = loadStablePlayerId() || myPlayerId.value
      console.log('Saved original player ID for reconnection (stable):', originalPlayerId)

      // Пытаемся переподключиться к хосту
      await peerService.connectToHost(targetHostId)

      // Обновляем свой ID на новый PeerJS ID
      myPlayerId.value = peerService.getMyId() || ''
      console.log('Updated to new peer ID:', myPlayerId.value)
      // Обновляем устойчивый id, если еще не сохранен
      if (myPlayerId.value) saveStablePlayerId(myPlayerId.value)

      // Устанавливаем роль клиента
      isHost.value = false
      hostId.value = targetHostId
      peerService.setAsClient()

      // Настраиваем обработчики
      setupClientMessageHandlers()

      // КРИТИЧНО: Добавляем mesh-обработчики при восстановлении
      setupMeshProtocolHandlers()

      // Прочистим неактивные соединения
      try { peerService.cleanupInactiveConnections() } catch {}

      // Ждем немного для установки соединения
      await new Promise(resolve => setTimeout(resolve, 300))

      // Идемпотентная отправка join_request с ретраями до получения свежего состояния
      await sendWithRetry(
        targetHostId,
        () => makeMessage(
          'join_request',
          {
            nickname: myNickname.value,
            savedPlayerId: originalPlayerId // Используем устойчивый/старый ID для поиска существующего игрока
          },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        ),
        3,
        300,
        true
      )

      // Идемпотентный запрос актуального состояния с ретраями
      await sendWithRetry(
        targetHostId,
        () => makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        ),
        3,
        300,
        true
      )

      // КРИТИЧНО: Запрашиваем список peer'ов для mesh-соединений
      await sendWithRetry(
        targetHostId,
        () => makeMessage(
          'request_peer_list',
          {
            requesterId: myPlayerId.value,
            requesterToken: '',
            timestamp: Date.now()
          },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        ),
        2,
        300,
        false
      )

      // Ждем получения обновленного состояния (быстрая проверка)
      await waitForGameStateUpdate()

      // Дополнительная защита: если после sync hostId в состоянии отличается от targetHostId — обновим локально
      if (gameState.value.hostId && hostId.value !== gameState.value.hostId) {
        console.log('Adjusting hostId after state sync:', { prev: hostId.value, next: gameState.value.hostId })
        hostId.value = gameState.value.hostId
      }

      // Быстрый mesh: запросим список пиров ещё раз через короткую задержку
      setTimeout(() => {
        try {
          peerService.sendMessage(
            targetHostId,
            makeMessage(
              'request_peer_list',
              {
                requesterId: myPlayerId.value,
                requesterToken: '',
                timestamp: Date.now()
              },
              { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
            )
          )
        } catch {}
      }, 300)

      console.log('Client restored and reconnected with updated state')
      // После получения state от хоста считаем, что восстановление успешно — отменяем любые локальные процедуры миграции
      try {
        if (peerService.isInHostRecoveryGracePeriod()) {
          peerService.cancelHostRecoveryGracePeriod()
        }
      } catch {}
    } catch (error: unknown) {
      console.error('Failed to restore as client:', error)
      // Если не удалось подключиться к старому хосту, пытаемся найти нового
      await onHostDisconnectedSafe()
    }
  }

  // Ожидание обновления состояния игры
  // BUGFIX: уменьшаем общее время ожидания и условия готовности, чтобы UI быстрее «просыпался» после reload
  const waitForGameStateUpdate = (): Promise<void> => {
    return new Promise((resolve) => {
      let attempts = 0
      const maxAttempts = 10 // было 20 -> ускоряем

      const snapshotPhase = gameState.value.phase

      const checkForUpdate = () => {
        attempts++

        // Достаточно иметь хотя бы 1 игрока и валидную фазу
        const hasAnyPlayers = gameState.value.players.length > 0

        // Корректность litUpPlayerId: если указана, должна существовать
        const litUpPlayerValid = !gameState.value.litUpPlayerId ||
          gameState.value.players.some((p: Player) => p.id === gameState.value.litUpPlayerId)

        // Если в снапшоте была не 'lobby' — ждём не-lobby
        const phaseConsistent = snapshotPhase && snapshotPhase !== 'lobby'
          ? (gameState.value.phase && gameState.value.phase !== 'lobby')
          : true

        if ((hasAnyPlayers && litUpPlayerValid && phaseConsistent) || attempts >= maxAttempts) {
          if (gameState.value.litUpPlayerId && !litUpPlayerValid) {
            console.log('Clearing invalid litUpPlayerId:', gameState.value.litUpPlayerId)
            gameState.value.litUpPlayerId = null
          }

          if ((gameState.value.phase ?? 'lobby') !== 'lobby') {
            gameState.value.gameStarted = true
          }

          console.log('Game state synchronized (fast), players:', gameState.value.players.length,
            'phase:', gameState.value.phase,
            'litUpPlayerId:', gameState.value.litUpPlayerId,
            'hostId:', gameState.value.hostId,
            'roomId:', gameState.value.roomId)
          resolve()
        } else {
          if (attempts === Math.floor(maxAttempts / 2)) {
            console.log('⏳ Waiting for state sync...', {
              attempts,
              players: gameState.value.players.length,
              phase: gameState.value.phase,
              hostId: gameState.value.hostId,
              roomId: gameState.value.roomId
            })
          }
          setTimeout(checkForUpdate, 150) // быстрее цикл
        }
      }

      setTimeout(checkForUpdate, 150)
    })
  }

  // Проверка наличия активной сессии
  const hasActiveSession = (): boolean => {
    const sessionData = loadSession()
    return sessionData !== null
  }


  // Клиентский "мягкий" выход с сохранением очков и присутствием 'absent'
  // Требования:
  // - Оптимистически помечаем себя "Отсутствует"
  // - Шлём user_left_room с (userId, roomId, timestamp, currentScore, reason)
  // - Блокируем элементы управления, зависящие от присутствия (через isCurrentUserAbsent)
  // - При ошибке откатываем статус и показываем уведомление
  const clientLeaveRoom = async () => {
    try {
      // Инициализация контейнеров присутствия
      if (!gameState.value.presence) gameState.value.presence = {}
      if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}

      const me = myPlayerId.value
      const nowTs = Date.now()

      // 1) Оптимистический апдейт локального UI
      if (me) {
        gameState.value.presence[me] = 'absent'
        gameState.value.presenceMeta[me] = {
          lastSeen: Math.max(nowTs, gameState.value.presenceMeta[me]?.lastSeen || 0),
          leftAt: nowTs,
          reason: 'explicit_leave'
        }
      }

      // 2) Формируем и отправляем событие user_left_room (одна попытка, без ретраев)
      const payload = {
        userId: me,
        roomId: roomId.value || gameState.value.roomId,
        timestamp: nowTs,
        currentScore: gameState.value.scores?.[me] ?? 0,
        reason: 'explicit_leave' as const
      }

      try {
        peerService.sendMessage(
          hostId.value || gameState.value.hostId,
          makeMessage(
            'user_left_room',
            payload as any,
            { roomId: payload.roomId, fromId: me, ts: Date.now() }
          )
        )
      } catch {
        // Игнорируем: это best-effort уведомление, хост может обработать по таймауту присутствия
      }

      // 3) Отключаемся и чистим локальные данные, но не сбрасываем визуально историю очков
      peerService.disconnect()
      clearSession()
      connectionStatus.value = 'disconnected'
    } catch (e) {
      // 4) Откат оптимистического апдейта
      const me = myPlayerId.value
      if (me) {
        if (!gameState.value.presence) gameState.value.presence = {}
        if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
        gameState.value.presence[me] = 'present'
        const lastSeen = Math.max(Date.now(), gameState.value.presenceMeta[me]?.lastSeen || 0)
        gameState.value.presenceMeta[me] = { lastSeen }
      }
      // Простое уведомление об ошибке (можно заменить на тостер)
      try {
        // eslint-disable-next-line no-alert
        alert('Не удалось покинуть комнату. Повторите попытку.')
      } catch {}
      throw e
    }
  }

  // Покинуть комнату
  const leaveRoom = () => {
    // КРИТИЧНО: Очищаем сохраненный peer ID хоста при покидании комнаты
    if (roomId.value && isHost.value) {
      console.log('🗑️ Clearing saved host peer ID for room:', roomId.value)
      peerService.clearSavedHostId(roomId.value)
      // Не трогаем ROOM_ID_STORAGE_KEY здесь, чтобы при случайной перезагрузке вкладки хоста roomId сохранялся
    }

    // Отключаемся от сети и чистим сессию/хранилище
    peerService.disconnect()
    clearSession()
    // Чистим все game-префикс ключи, никнейм сохраняется отдельно (без префикса)
    removeGameItemsByPrefix()

    // Полный сброс Pinia state к дефолту
    // 1) Базовые refs
    myPlayerId.value = ''
    isHost.value = false
    hostId.value = ''
    roomId.value = ''
    connectionStatus.value = 'disconnected'
    gameMode.value = 'basic'
    gamePhase.value = 'lobby'
    currentRound.value = 1

    // 2) Никнейм сохраняем в отдельном ключе, затем очищаем локальный ref
    if (!myNickname.value.startsWith(NICKNAME_PREFIX)) {
      try { setNickname(myNickname.value || generateDefaultNickname()) } catch {}
    }
    myNickname.value = ''

    // 3) Сброс версии/синхронизации
    currentVersion.value = 0
    initReceived.value = false
    lastServerTime.value = 0
    pendingDiffs.value.clear()
    if (_snapshotTimeoutHandle) {
      clearTimeout(_snapshotTimeoutHandle)
      _snapshotTimeoutHandle = null
    }
    _acceptLegacyAsInit.value = false
    gotFreshState.value = false

    // 4) Сброс миграционного состояния
    resetMigrationState()
    try {
      if (peerService.isInHostRecoveryGracePeriod()) {
        peerService.cancelHostRecoveryGracePeriod()
      }
    } catch {}

    // 5) Сброс состояния игры к дефолту
    gameState.value = {
      roomId: '',
      gameStarted: false,
      players: [],
      litUpPlayerId: null,
      maxPlayers: 8,
      hostId: '',
      createdAt: 0,
      questionCards: [],
      votingCards: {},
      bettingCards: {},
      currentTurn: 0,
      scores: {},
      // Для режима 2.0 (advanced)
      answers: {},
      guesses: {},
      currentQuestion: null,
      votes: {},
      bets: {}
    }

    // 6) Сброс любых runtime-хранилищ снапшотов
    try { storageSafe.nsRemove('game', 'hostGameStateSnapshot') } catch {}
    // 7) Сброс устойчивого playerId
    try { clearStablePlayerId() } catch {}

    console.log('✅ Pinia state fully reset to defaults after leaving room')
  }

  // Доступность и локализация: вычисляемые помощники для UI
  const isCurrentUserAbsent = computed<boolean>(() => {
    const me = myPlayerId.value
    const st = gameState.value.presence?.[me]
    return st === 'absent'
  })

  // Уведомления ARIA-live: вызывайте в компонентах при событиях user_left_broadcast/user_joined_broadcast
  const ariaAnnounce = (text: string) => {
    try {
      const regionId = 'aria-live-region'
      let region = document.getElementById(regionId)
      if (!region) {
        region = document.createElement('div')
        region.id = regionId
        region.setAttribute('role', 'status')
        region.setAttribute('aria-live', 'polite')
        region.style.position = 'absolute'
        region.style.width = '1px'
        region.style.height = '1px'
        region.style.overflow = 'hidden'
        region.style.clip = 'rect(1px, 1px, 1px, 1px)'
        region.style.clipPath = 'inset(50%)'
        region.style.whiteSpace = 'nowrap'
        region.style.border = '0'
        document.body.appendChild(region)
      }
      region.textContent = text
    } catch {}
  }

  // Установка никнейма по умолчанию при инициализации
  if (!myNickname.value) {
    // Пытаемся взять сохранённый ник из non-prefixed ключа
    myNickname.value = getNickname() || generateDefaultNickname()
  }

  // При инициализации, если мы будем создавать комнату — переиспользуем стабильный roomId
  const preloadedRoomId = loadPersistentRoomId()
  if (preloadedRoomId && !roomId.value) {
    roomId.value = preloadedRoomId
  }

  // Реакция на пульс/исчезновение хоста (peerService уже вызывает onHostDisconnected callback)
  try {
    peerService.onHostDisconnected(async () => {
      console.log('peerService reported host disconnection, starting handling')
      await onHostDisconnectedSafe()
    })
  } catch {}

  // Автоматическое сохранение сессии при изменениях
  watch(
    [gameState, myPlayerId, myNickname, isHost, hostId, roomId, connectionStatus],
    () => {
      // При успешном подключении фиксируем метку времени
      if (connectionStatus.value === 'connected') {
        sessionTimestamp.value = Date.now()
      }
      // Сохраняем только если подключены
      if (connectionStatus.value === 'connected' && myPlayerId.value) {
        saveSession()
      }
    },
    {deep: true}
  )

  // -------- Клиентские экшены-обертки: отправка сообщений хосту --------

  const clientDrawQuestion = () => {
    if (!gameState.value.currentTurnPlayerId) return
    if (isHost.value) {
      // Хост выполняет локально в свой ход
      drawCard(myPlayerId.value)
    } else {
      // Клиент отправляет явный свой ID
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'draw_question_request',
          { playerId: myPlayerId.value },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  const clientSubmitVote = (votes: string[]) => {
    if (isHost.value) {
      submitVote(myPlayerId.value, votes)
    } else {
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'submit_vote',
          { voterId: myPlayerId.value, targetIds: votes },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  const clientSubmitBet = (bet: '0' | '±' | '+') => {
    if (isHost.value) {
      submitBet(myPlayerId.value, bet)
    } else {
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'submit_bet',
          { playerId: myPlayerId.value, bet },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  const clientSubmitAnswer = (answer: string) => {
    if (isHost.value) {
      // Хост локально заполняет и двигает фазу
      if (gamePhase.value === 'answering' && myPlayerId.value === gameState.value.answeringPlayerId) {
        gameState.value.advancedAnswer = answer
        gamePhase.value = 'guessing'
        gameState.value.phase = 'guessing'
        broadcastGameState()
      }
    } else {
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'submit_answer',
          { playerId: myPlayerId.value, answer },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  const clientSubmitGuess = (guess: string) => {
    if (isHost.value) {
      if (!gameState.value.guesses) gameState.value.guesses = {}
      gameState.value.guesses[myPlayerId.value] = guess
      broadcastGameState()
    } else {
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'submit_guess',
          { playerId: myPlayerId.value, guess },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  // Любой игрок (хост или клиент) может запросить следующий раунд после консенсуса
  // Выбор победителей в advanced: делает только автор правильного ответа (answeringPlayerId)
  const submitWinners = (winnerIds: string[]) => {
    if (!isHost.value) return

    // Ведем проверку по состоянию в gameState приоритетно
    const mode = gameState.value.gameMode ?? gameMode.value
    const phase = gameState.value.phase ?? gamePhase.value
    if (mode !== 'advanced') return
    if (phase !== 'selecting_winners') return

    const chooserId = gameState.value.answeringPlayerId
    if (!chooserId) return

    // Нормализуем winners на стороне хоста: уникальные, только те у кого есть валидная догадка в текущем раунде,
    // исключая chooserId и игроков без догадки
    const validSet = new Set(
      (winnerIds || []).filter(id =>
        id &&
        id !== chooserId &&
        // есть догадка именно в этом раунде
        !!(gameState.value.guesses && typeof gameState.value.guesses[id] === 'string' && gameState.value.guesses[id].trim().length > 0) &&
        // игрок существует
        gameState.value.players.some(p => p.id === id)
      )
    )
    const winners = Array.from(validSet)

    if (!gameState.value.roundScores) gameState.value.roundScores = {}
    gameState.value.roundWinners = winners

    // Начисляем по 1 баллу каждому выбранному (только тем, кто отправил догадку)
    winners.forEach(pid => {
      gameState.value.roundScores![pid] = (gameState.value.roundScores![pid] || 0) + 1
      gameState.value.scores[pid] = (gameState.value.scores[pid] || 0) + 1
    })

    // Переходим к итогам advanced
    gamePhase.value = 'advanced_results'
    gameState.value.phase = 'advanced_results'
    broadcastGameState()
  }

  // Клиентский хелпер для отправки победителей
  const clientSubmitWinners = (winnerIds: string[]) => {
    if (isHost.value) {
      submitWinners(winnerIds)
    } else {
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'submit_winners',
          { chooserId: myPlayerId.value, winners: winnerIds },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  // Удалено: повторное объявление migrationState (вызывало TS-ошибку "Cannot redeclare")
  // Если нужно глобально кешировать — можно привязать ссылку без повторного объявления:
  try {
    (globalThis as any).__migrationState = (globalThis as any).__migrationState || migrationState.value
  } catch {}

  const clientNextRound = () => {
    if (isHost.value) {
      // Хост выполняет локально ту же логику
      if (gamePhase.value !== 'results' && gamePhase.value !== 'advanced_results') return

      const totalPlayers = gameState.value.players.length

      if (gameMode.value === 'basic') {
        const allVoted = Object.keys(gameState.value.votes || {}).length >= totalPlayers
        const allBet = Object.keys(gameState.value.bets || {}).length >= totalPlayers
        const resultsReady = gamePhase.value === 'results'
        if (!(allVoted && allBet && resultsReady)) return
      } else {
        const votedCount = Object.keys(gameState.value.votes || {}).length
        const guessesCount = Object.keys(gameState.value.guesses || {}).filter(pid => pid !== gameState.value.answeringPlayerId).length
        const requiredGuesses = Math.max(0, totalPlayers - 1)
        const resultsReady = gamePhase.value === 'advanced_results'
        if (!(votedCount >= totalPlayers && guessesCount >= requiredGuesses && resultsReady)) return
      }

      finishRoundHostOnly()
    } else {
      // Клиент отправляет запрос хосту
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'next_round_request',
          { playerId: myPlayerId.value },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
    }
  }

  // UI helper: признак процесса восстановления/переподключения
  const uiConnecting = computed<boolean>(() => {
    return connectionStatus.value === 'connecting' || restorationState.value !== 'idle'
  })

  // ===== ДЕТЕРМИНИРОВАННАЯ ЭЛЕКЦИЯ ХОСТА ПО МИНИМАЛЬНОМУ ID =====

  // Находит игрока с минимальным id (строковое сравнение, id === peerId)
  function getMinIdHostCandidate(players: Player[]): Player | null {
    if (!players || players.length === 0) return null
    const sorted = [...players].sort((a, b) => (a.id || '').localeCompare(b.id || ''))
    return sorted[0] || null
  }

  // Отправка клиентам уведомления о новом хосте
  function broadcastNewHostId(newHostId: string) {
    try {
      const msg = makeMessage(
        'new_host_id' as any,
        {
          roomId: roomId.value || gameState.value.roomId,
          newHostId
        } as any,
        { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
      )
      peerService.broadcastMessage(msg)
      console.log('📢 Broadcasted new_host_id:', newHostId)
    } catch (e) {
      console.warn('Failed to broadcast new_host_id', e)
    }
  }

  // Ожидание подтверждений от клиентов, что они обновили у себя нового хоста
  async function waitClientsAckNewHost(newHostId: string, timeoutMs = 3000): Promise<void> {
    return new Promise((resolve) => {
      const expectedIds = new Set<string>(
        (gameState.value.players || [])
          .map(p => p.id)
          .filter(pid => pid && pid !== newHostId)
      )
      if (expectedIds.size === 0) {
        resolve()
        return
      }

      const handler = (m: any) => {
        try {
          if ((m as any).type !== 'client_host_update_ack') return
          const payload = (m as any).payload || {}
          if (!payload || payload.hostId !== newHostId) return
          const from = m.meta?.fromId
          if (from && expectedIds.has(from)) {
            expectedIds.delete(from)
            if (expectedIds.size === 0) {
            }
          }
        } catch {}
      }

      // Регистрируем временный обработчик ACK
      peerService.onMessage('client_host_update_ack', handler as any)

      // Таймаут ожидания
      setTimeout(() => {
        try {
          peerService.clearMessageHandlers()
          setupHostMessageHandlers()
          setupMeshProtocolHandlers()
        } catch {}
        console.warn('Timeout waiting for client_host_update_ack, continuing...')
        resolve()
      }, timeoutMs)
    })
  }

  // Публикуем полный снимок состояния всем клиентам (новый хост)
  function hostBroadcastFullSnapshot() {
    try {
      const payload: any = {
        meta: {
          roomId: roomId.value || gameState.value.roomId,
          version: currentVersion.value || 0,
          serverTime: Date.now()
        },
        state: { ...gameState.value }
      }
      // Отправляем индивидуально всем известным коннектам
      peerService.getConnectedPeers().forEach(pid => {
        try { peerService.hostSendSnapshot(pid, payload) } catch {}
      })
      console.log('📤 New host broadcasted state_snapshot to all clients')
    } catch (e) {
      console.warn('Failed to broadcast full snapshot by new host', e)
    }
  }

  // Поднять себя в хосты и разослать всем уведомления + снапшот
  async function promoteToHostDeterministic(): Promise<void> {
    // Восстановить как хост (создает Peer/ID, включает heartbeat хоста)
    await restoreAsHost()

    // В состоянии hostId должен быть установлен на новый peer id
    const newHostPeerId = myPlayerId.value
    // Важный момент: в players[] мой объект уже должен иметь мой новый id (restoreAsHost делает это)

    // Разослать new_host_id
    broadcastNewHostId(newHostPeerId)

    // Дать клиентам ack'нуть получение нового хоста
    await waitClientsAckNewHost(newHostPeerId, 2000)

    // Разослать state_snapshot, чтобы клиенты обновили список игроков/hostId
    hostBroadcastFullSnapshot()
    console.log('✅ Deterministic host promotion finalized with snapshot')
  }

  // Обработчик смены хоста на стороне клиента:
  function setupClientNewHostHandlers() {
    // Клиентский обработчик new_host_id
    peerService.onMessage('new_host_id', (message) => {
      const payload = (message as any).payload || {}
      const newHost = payload.newHostId as string
      const rid = payload.roomId as string
      console.log('📥 CLIENT received new_host_id:', newHost)

      // Обновляем локальный hostId
      if (newHost) {
        hostId.value = newHost
        gameState.value.hostId = newHost
      }
      if (rid && !roomId.value) {
        roomId.value = rid
      }

      // Отправляем подтверждение обратно новому хосту
      try {
        peerService.sendMessage(
          newHost,
          makeMessage(
            'client_host_update_ack' as any,
            { hostId: newHost, ok: true } as any,
            { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
          )
        )
        console.log('📤 CLIENT sent client_host_update_ack to:', newHost)
      } catch (e) {
        console.warn('Failed to send client_host_update_ack', e)
      }

      // Переключаемся в режим клиента и переподключаемся к новому хосту при необходимости
      isHost.value = false
      try {
        // не ломаем текущие соединения, основной канал к хосту переустановит restoreAsClient путь позже
      } catch {}
    })
  }

  // Жёсткие гарантии против двойного takeover:
  // 1) если выбран детерминированный хост по min(id) и это НЕ мы — запрещаем emergency takeover
  function shouldBlockEmergencyTakeover(): boolean {
    try {
      const players = (gameState.value.players || []).filter(Boolean)
      const candidate = getMinIdHostCandidate(players)
      if (candidate && candidate.id !== myPlayerId.value) {
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // Патч места, где может запускаться emergency takeover: если блок активен — выходим
  const _origBecomeNewHostWithRecovery = (async () => {}) as any
  // защитный хук — используйте в местах emergency takeover перед promoteToHost
  const guardEmergencyOrPromote = async (promote: () => Promise<void>) => {
    if (migrationState.value.emergencyLock || shouldBlockEmergencyTakeover()) {
      console.log('🛑 Emergency takeover blocked due to deterministic host selection')
      return
    }
    await promote()
  }

  // Инициализация клиентских обработчиков для new_host_id (только однажды при создании стора)
  try { setupClientNewHostHandlers() } catch {}

  // Клиент: маршрутизируем heartbeat от пира в peerService для отслеживания таймаута хоста
  peerService.onMessage('heartbeat', (message) => {
    const payload = (message as any).payload || {}
    const fromId = payload?.hostId || (message as any).meta?.fromId
    if (fromId) {
      peerService.handleHeartbeat(fromId)
    }
  })

  return {
    // State
    gameState,
    myPlayerId,
    myNickname,
    isHost,
    hostId,
    roomId,
    connectionStatus,
    sessionTimestamp,
    gameMode,
    gamePhase,
    uiConnecting,
    // Presence helpers for UI
    isCurrentUserAbsent,
    ariaAnnounce,

    // Computed
    canStartGame,
    myPlayer,
    canJoinRoom,
    currentRound,
    currentMode,
    roundsLeft,

    // Actions
    createRoom,
    joinRoom,
    startGame,
    lightUpPlayer,
    // Host-side direct actions (используются хостом)
    drawCard,
    submitVote,
    submitBet,
    finishRound: finishRoundHostOnly,
    leaveRoom,
    leaveGracefully: clientLeaveRoom,
    broadcastGameState,

    // Client-side actions (обертки, отправка сообщений)
    drawQuestion: clientDrawQuestion,
    sendVote: clientSubmitVote,
    sendBet: clientSubmitBet,
    sendAnswer: clientSubmitAnswer,
    sendGuess: clientSubmitGuess,
    sendWinners: clientSubmitWinners,
    nextRound: clientNextRound,

    // Advanced mode actions (удерживаем, но использовать следует клиентские обертки)
    submitAnswer: (playerId: string, answer: string) => {
      if (!gameState.value.answers) gameState.value.answers = {};
      gameState.value.answers[playerId] = answer;
    },
    submitGuess: (playerId: string, guess: string) => {
      if (!gameState.value.guesses) gameState.value.guesses = {};
      gameState.value.guesses[playerId] = guess;
    },

    // Session Management
    saveSession,
    restoreSession,
    hasActiveSession,
    clearSession,
    generateDefaultNickname,

    // Request guard UI flags
    isLoadingCreateRoom,
    isLoadingJoinRoom,
    isLoadingRestore,
    lastErrorCreateRoom,
    lastErrorJoinRoom,
    lastErrorRestore
  }
}, {
  // ВАЖНО: перенесли persist-конфиг в options третьим аргументом,
  // чтобы плагин видел его через context.options.persist и корректно активировался
  persist: {
    key: 'game',
    version: 1,
    debounceMs: 200,
    syncTabs: true,
    paths: [
      'myPlayerId',
      'myNickname',
      'isHost',
      'hostId',
      'roomId',
      'connectionStatus',
      'sessionTimestamp'
    ]
  } as any
})
