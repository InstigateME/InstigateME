import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { Mutex } from 'async-mutex'
import { storageSafe } from '@/utils/storageSafe'
import { isDebugEnabled } from '@/utils/debug'
import router from '@/router'
import { GAME_CONFIG, PLAYER_COLORS, NICKNAME_PREFIX, ROOM_ID_WORDS, DEFAULT_CARDS } from '@/config/gameConfig'
// Импорт удален - больше нет миграции хоста
import type {
  Player,
  GameState,
  PeerMessage,
  HostDiscoveryRequestPayload,
  HostDiscoveryResponsePayload,
  ExtendedSessionData,
  HostRecoveryAnnouncementPayload,
} from '@/types/game'
import { makeMessage } from '@/types/game'
import type { MessageMeta } from '@/types/game'
import { peerService } from '@/services/peerSelector'



/**
 * Персистентность и синхронизация
 * - Pinia persist: атомарные поля (см. persist.paths ниже)
 * - storageSafe (namespace 'game'): TTL-снапшот hostGameStateSnapshot, стабильный roomId
 */
const HOST_SNAPSHOT_TTL = 15 * 60 * 1000 // 15 минут

// ---------- Request guards & standardized errors ----------
type RequestKey = 'createRoom' | 'joinRoom' | 'restoreSession'
type RequestStatus = 'idle' | 'pending' | 'success' | 'error'
type RequestMap = Record<
  RequestKey,
  {
    status: RequestStatus
    requestId: number
    error: StandardError | null
  }
>

interface StandardError {
  code?: string
  message: string
  details?: unknown
  at: number
}

// Флаг для предотвращения переподключения при добровольном выходе
let isVoluntaryLeaving = false

// last-write-wins счетчик
const requestSeq = ref(0)
const requests = ref<RequestMap>({
  createRoom: { status: 'idle', requestId: 0, error: null },
  joinRoom: { status: 'idle', requestId: 0, error: null },
  restoreSession: { status: 'idle', requestId: 0, error: null },
})

function normalizeError(e: unknown, code?: string): StandardError {
  if (e && typeof e === 'object' && 'message' in e) {
    return {
      code,
      message: String((e as any).message ?? 'Unknown error'),
      details: e,
      at: Date.now(),
    }
  }
  return {
    code,
    message: typeof e === 'string' ? e : 'Unknown error',
    details: e,
    at: Date.now(),
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
  // Debug flag: включается, если в localStorage есть "__app_debug"
  const isDebug = computed<boolean>(() => isDebugEnabled())
  // ---------- StorageSafe wrappers ----------
  // Очистка namespace 'game'
  const removeGameItemsByPrefix = () => {
    try {
      storageSafe.clearNamespace('game')
    } catch {}
  }
  // Никнейм хранится БЕЗ префикса по требованию — предполагаем отдельные хелперы не используются.
  // Сохраняем ник напрямую в non-prefixed ключ (совместимость с требованиями).
  const NICK_STORAGE_KEY = 'nickname'
  const setNickname = (nick: string) => {
    try {
      localStorage.setItem(NICK_STORAGE_KEY, nick)
    } catch {}
  }
  const getNickname = (): string | null => {
    try {
      return localStorage.getItem(NICK_STORAGE_KEY)
    } catch {
      return null
    }
  }
  const clearNickname = () => {
    try {
      localStorage.removeItem(NICK_STORAGE_KEY)
    } catch {}
  }

  // Game mechanics for "Провокатор"
  // Структура голосов: { [voterId]: [targetId, targetId] }
  // Структура ставок: { [playerId]: '0' | '±' | '+' }
  // Структура очков: { [playerId]: number }

  // Режим игры: 'basic' — обычный, 'advanced' — 2.0 (с письменными ответами)
  // gameMode хранит текущий активный режим и синхронизируется в gameState для клиентов.
  const gameMode = ref<'basic' | 'advanced'>('basic')
  const gamePhase = ref<
    | 'lobby'
    | 'drawing_question'
    | 'voting'
    | 'secret_voting'
    | 'betting'
    | 'results'
    | 'answering'
    | 'guessing'
    | 'selecting_winners'
    | 'advanced_results'
    | 'game_over'
  >('lobby')

  // Чередование: количество раундов из конфига, нечетные — basic, четные — advanced
  const TOTAL_ROUNDS = GAME_CONFIG.TOTAL_ROUNDS
  const currentRound = ref<number>(1)
  const currentMode = computed<'basic' | 'advanced'>(() =>
    currentRound.value % 2 === 1 ? 'basic' : 'advanced',
  )
  // Количество оставшихся раундов: без +1, иначе на последнем раунде остается "1" и логика конца игры не срабатывает
  const roundsLeft = computed<number>(() => Math.max(0, TOTAL_ROUNDS - currentRound.value))

  // Следующий раунд: инкрементируем счетчик до 16 и пересчитываем режим
  const advanceRound = () => {
    const oldRound = currentRound.value
    const oldMode = gameMode.value
    
    // Инкремент номера раунда всегда, а проверку конца игры делаем ниже в переходе фаз
    currentRound.value += 1

    // Обновляем режим согласно чередованию и синхронизируем в state
    gameMode.value = currentMode.value
    gameState.value.gameMode = currentMode.value
    
    console.log(`🔄 ROUND ADVANCE: ${oldRound} (${oldMode}) → ${currentRound.value} (${gameMode.value})`)
  }

  // Две независимые колоды индексов вопросов на игру (перетасовываются один раз при старте)
  const basicDeck = ref<number[]>([])
  const advancedDeck = ref<number[]>([])

  // Индексы вопросов импортируются динамически в initializeGame из '@/data/questions.ts'

  const initializeGame = async (mode: 'basic' | 'advanced' = 'basic') => {
    gamePhase.value = 'lobby'
    gameMode.value = mode
    gameState.value.gameMode = mode
    gameState.value.phase = 'lobby'

    try {
      const mod = await import('@/data/questions')
      const questionsBasic = Array.isArray(mod?.default?.questionsBasic)
        ? mod.default.questionsBasic
        : []
      const questionsAdvanced = Array.isArray(mod?.default?.questionsAdvanced)
        ? mod.default.questionsAdvanced
        : []

      // Генерируем массив индексов и перемешиваем
      const fyShuffle = (arr: number[]) => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[arr[i], arr[j]] = [arr[j], arr[i]]
        }
        return arr
      }

      basicDeck.value = fyShuffle([...Array(questionsBasic.length).keys()])
      advancedDeck.value = fyShuffle([...Array(questionsAdvanced.length).keys()])

      // В state храним только индексы активной колоды
      gameState.value.questionIndices =
        currentMode.value === 'basic' ? basicDeck.value.slice() : advancedDeck.value.slice()
    } catch {
      basicDeck.value = []
      advancedDeck.value = []
      gameState.value.questionIndices = []
    }

    // Инициализация карт и очков
    gameState.value.scores = {}
    gameState.value.players.forEach((player) => {
      player.votingCards = [...DEFAULT_CARDS.voting]
      player.bettingCards = [...DEFAULT_CARDS.betting]
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

    // Переводим в фазу вытягивания вопроса и синхронизируем snapshot активной колоды
    gamePhase.value = 'drawing_question'
    gameState.value.phase = 'drawing_question'
    {
      const activeDeckRef = currentMode.value === 'basic' ? basicDeck : advancedDeck
      gameState.value.questionIndices = activeDeckRef.value.slice()
    }
  }

  // Обработка голосов и ставок после раунда
  // Подсчёт очков базового режима
  const processRound = () => {
    // Безопасно получаем значения
    const votesObj = gameState.value.votes ?? {}
    const betsObj = gameState.value.bets ?? {}

    // Подсчёт голосов за каждого игрока
    const voteCounts: Record<string, number> = {}
    Object.values(votesObj).forEach((voteArr: string[]) => {
      voteArr.forEach((targetId) => {
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
    gameState.value.players.forEach((player) => {
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
  }

  // mode: 'basic' | 'advanced'
  const startGame = (mode: 'basic' | 'advanced' = 'basic') => {
    if (!isHost.value) return

    // Стартовать можно только из лобби
    const isLobby = (gameState.value.phase ?? 'lobby') === 'lobby'
    if (!isLobby) return

    // Минимум игроков из конфига, чтобы не залипать в ожидании
    if (gameState.value.players.length < GAME_CONFIG.MIN_PLAYERS) return

    // Инициализируем игру и явно дублируем всё в gameState для клиентов
    // Параметр mode больше НЕ фиксирует режим — режим строго задается чередованием по currentRound.
    // Важно: initializeGame асинхронная — но нам не нужен await, нам нужно последовательное выставление фаз ниже.
    void initializeGame(mode)

    // Помечаем игру как начатую
    gameState.value.gameStarted = true

    // Синхронизируем режим строго из currentMode (источник правды — номер раунда)
    gameMode.value = currentMode.value
    gameState.value.gameMode = currentMode.value

    // Переключаемся в фазу вытягивания вопроса сразу, чтобы клиенты не оставались в 'lobby'
    gamePhase.value = 'drawing_question'
    gameState.value.phase = 'drawing_question'

    // Инициализируем первый ход на всякий случай (если initializeGame ещё не успела)
    if (!gameState.value.currentTurnPlayerId) {
      gameState.value.currentTurn = 0
      gameState.value.currentTurnPlayerId = gameState.value.players[0]?.id || null
    }

    // Немедленно шлем актуальное состояние всем клиентам
    broadcastGameState()
  }

  // ВАЖНО: drawCard вызывается на стороне хоста (локально у хоста), но инициироваться может клиентом через draw_question_request.
  // Не полагаемся на myPlayerId на хосте, а проверяем requesterId, который передаём из обработчика сообщения.
  // Сброс состояния голосования/ставок/аггрегатов перед началом нового голосования
  const resetVotingState = () => {
    // Очищаем данные предыдущего раунда голосования, чтобы старые выборы не учитывались
    gameState.value.votes = {}
    gameState.value.voteCounts = {}
    gameState.value.bets = {}
    // В advanced режиме также чистим связанные выборы/победителей текущего раунда
    if (gameMode.value === 'advanced') {
      gameState.value.guesses = {}
      ;(gameState.value as any).roundWinners = []
      gameState.value.answeringPlayerId = null
      gameState.value.advancedAnswer = null
    }
  }

  const drawCard = async (requesterId?: string | null) => {
    logAction('drawCard_request', { requesterId })
    if (gamePhase.value !== 'drawing_question') return null

    const currentTurnPid = gameState.value.currentTurnPlayerId
    if (!currentTurnPid) return null

    if (requesterId && requesterId !== currentTurnPid) return null

    const activeDeckRef = currentMode.value === 'basic' ? basicDeck : advancedDeck

    // Если активная колода пуста — перетасовываем заново
    if (activeDeckRef.value.length === 0) {
      try {
        const mod = await import('@/data/questions')
        const source =
          currentMode.value === 'basic'
            ? Array.isArray(mod?.default?.questionsBasic)
              ? mod.default.questionsBasic
              : []
            : Array.isArray(mod?.default?.questionsAdvanced)
              ? mod.default.questionsAdvanced
              : []

        activeDeckRef.value = [...Array(source.length).keys()]
        // Перемешать
        for (let i = activeDeckRef.value.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[activeDeckRef.value[i], activeDeckRef.value[j]] = [
            activeDeckRef.value[j],
            activeDeckRef.value[i],
          ]
        }
      } catch {
        activeDeckRef.value = []
      }
    }

    if (activeDeckRef.value.length === 0) return null

    // Вытягиваем индекс из соответствующей колоды
    const cardIndex = activeDeckRef.value.shift()
    const card = typeof cardIndex === 'number' ? cardIndex : null

    // Обновляем snapshot для UI
    gameState.value.questionIndices = activeDeckRef.value.slice()
    gameState.value.currentQuestion = card

    gameState.value.phase = 'drawing_question'
    gamePhase.value = 'drawing_question'
    broadcastGameState()

    resetVotingState()

    resetVotingState()
    gameMode.value = currentMode.value
    gameState.value.gameMode = currentMode.value
    const nextPhase = gameMode.value === 'basic' ? 'voting' : 'secret_voting'
    gamePhase.value = nextPhase
    gameState.value.phase = nextPhase
    
    console.log(`🎯 PHASE SET: mode=${gameMode.value} → phase=${nextPhase} (round=${currentRound.value})`)
    
    broadcastGameState()

    return card
  }

  // --- Мьютексы для критических секций ---
  const voteMutex = new Mutex()
  const betMutex = new Mutex()

  // Игрок делает голос: votesArr — массив из двух id выбранных игроков
  const submitVote = async (voterId: string, votesArr: string[]) => {
    console.log('[MUTEX] submitVote: ожидаем мьютекс', voterId)
    await voteMutex.runExclusive(async () => {
      console.log('[MUTEX] submitVote: вошли в критическую секцию', voterId)
      logAction('submit_vote', { voterId, votes: votesArr })
      if (gamePhase.value !== 'voting' && gamePhase.value !== 'secret_voting') {
        console.log('[MUTEX] submitVote: невалидная фаза, выход', gamePhase.value)
        return
      }
      if (!gameState.value.votes) gameState.value.votes = {}
      gameState.value.votes[voterId] = votesArr
      gameState.value.stateVersion = (gameState.value.stateVersion || 1) + 1
      broadcastGameState()
      console.log('[MUTEX] submitVote: после broadcastGameState')

      // Автопереход фазы: когда ВСЕ активные игроки проголосовали, двигаем voting -> betting (basic) или secret_voting -> answering (advanced)
      if (((gameMode.value === 'advanced' && gamePhase.value === 'secret_voting') || 
           (gameMode.value === 'basic' && gamePhase.value === 'voting')) && isHost.value) {
        debugSnapshot('before_secret_to_answering_check')
        // Количество активных игроков (исключаем отсутствующих)
        const activePlayers = (gameState.value.players || []).filter((p) => {
          const st = gameState.value.presence?.[p.id]
          return st !== 'absent'
        })
        const requiredVotes = activePlayers.length
        const receivedVotes = Object.keys(gameState.value.votes || {}).filter((pid) =>
          activePlayers.some((p) => p.id === pid),
        ).length

        console.log(
          '[MUTEX] submitVote: голосов получено',
          receivedVotes,
          'ожидается',
          requiredVotes,
        )

        if (receivedVotes >= requiredVotes && requiredVotes > 0) {
          // Подсчёт голосов и определение лидера
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

          if (gameMode.value === 'advanced') {
            // В advanced режиме: secret_voting -> answering
            gameState.value.answeringPlayerId = leaders[0] || null
            gamePhase.value = 'answering'
            gameState.value.phase = 'answering'
            console.log('[MUTEX] submitVote: автопереход фазы secret_voting -> answering')
          } else {
            // В basic режиме: voting -> betting
            gamePhase.value = 'betting'
            gameState.value.phase = 'betting'
            console.log('[MUTEX] submitVote: автопереход фазы voting -> betting')
          }
          broadcastGameState()
        }
      }
      console.log('[MUTEX] submitVote: выходим из критической секции', voterId)
    })
  }

  // Игрок делает ставку: bet — '0' | '±' | '+'
  const submitBet = async (playerId: string, bet: '0' | '±' | '+') => {
    console.log('[MUTEX] submitBet: ожидаем мьютекс', playerId)
    await betMutex.runExclusive(async () => {
      console.log('[MUTEX] submitBet: вошли в критическую секцию', playerId)
      logAction('submit_bet', { playerId, bet })
      if (gamePhase.value !== 'betting') {
        console.log('[MUTEX] submitBet: невалидная фаза, выход', gamePhase.value)
        return
      }
      if (!gameState.value.bets) gameState.value.bets = {}

      // Не даем менять ставку после первой фиксации (alreadyBet на клиенте), но защищаем и на хосте
      if (gameState.value.bets[playerId]) {
        console.log('[MUTEX] submitBet: ставка уже есть, выход')
        return
      }

      // Фиксируем ставку и сразу шлем обновление, чтобы UI в фазе results корректно показывал выбранное значение
      gameState.value.bets[playerId] = bet
      gameState.value.stateVersion = (gameState.value.stateVersion || 1) + 1
      broadcastGameState()
      console.log('[MUTEX] submitBet: после broadcastGameState')

      // Если все активные игроки сделали ставку — сразу считаем и показываем результаты
      const playersCount = gameState.value.players.length
      const betsCount = Object.keys(gameState.value.bets).length

      console.log('[MUTEX] submitBet: ставок получено', betsCount, 'ожидается', playersCount)

      if (betsCount >= playersCount) {
        logAction('bets_completed_process_round', { betsCount, playersCount })
        debugSnapshot('before_results_after_bets')
        processRound()
        gamePhase.value = 'results'
        gameState.value.phase = 'results'
        console.log('[MUTEX] submitBet: переход фазы -> results')
        broadcastGameState()
      }
      console.log('[MUTEX] submitBet: выходим из критической секции', playerId)
    })
  }

  // Завершить фазу/раунд локально на стороне хоста (используется из сетевого обработчика)
  // allowForce — принудительное продвижение (по кнопке «Продолжить» у хоста), игнорирует ожидание всех ставок.
  const finishRoundHostOnly = (allowForce: boolean = false) => {
    // Защита от преждевременного перехода из betting в results до получения всех ставок.
    // Если allowForce === true, разрешаем принудительный переход (по требованию заказчика).
    if (gameMode.value === 'basic' && gamePhase.value === 'betting' && !allowForce) {
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
        // Если allowForce === true, хост принудительно завершает голосование и переходит сразу к ставкам
        gamePhase.value = 'betting'
        gameState.value.phase = 'betting'
        broadcastGameState()
        logAction('basic_voting_to_betting' + (allowForce ? '_forced' : ''))
        debugSnapshot('after_switch_betting')
        return
      }

      // Если завершены ставки — считаем очки и показываем результаты
      if (gamePhase.value === 'betting') {
        // Если allowForce === true, считаем очки и показываем результаты, даже если не все ставки сделаны
        processRound()
        gamePhase.value = 'results'
        gameState.value.phase = 'results'
        broadcastGameState()
        return
      }

      // Если показаны результаты — готовим следующий раунд
      if (gamePhase.value === 'results') {
        // Переход хода
        const nextTurn =
          ((gameState.value.currentTurn || 0) + 1) % (gameState.value.players.length || 1)
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

        // Проверка на конец игры: когда превысили лимит после инкремента — завершаем
        if (currentRound.value > TOTAL_ROUNDS) {
          gamePhase.value = 'game_over'
          gameState.value.phase = 'game_over'
        } else {
    // Синхронизируем snapshot активной колоды для UI
    const activeDeckRef = currentMode.value === 'basic' ? basicDeck : advancedDeck
    gameState.value.questionIndices = activeDeckRef.value.slice()
    gamePhase.value = 'drawing_question'
    gameState.value.phase = 'drawing_question'
        }

        // Обновляем карты на руках (если нужно)
        gameState.value.players.forEach((player) => {
          player.votingCards = [...DEFAULT_CARDS.voting]
          player.bettingCards = [...DEFAULT_CARDS.betting]
        })

        broadcastGameState()
        return
      }
    } else {
      // advanced режим
      // Переход из secret_voting в answering выполняется строго в submitVote при завершении голосования,
      // чтобы избежать двойных переходов/гонок. Здесь ничего не делаем для secret_voting.
      if (gamePhase.value === 'secret_voting') {
        return
      }

      if (gamePhase.value === 'answering') {
        logAction('advanced_answering_to_guessing')
        debugSnapshot('after_switch_guessing')
        // Получили ответ — переходим к угадыванию
        gamePhase.value = 'guessing'
        gameState.value.phase = 'guessing'
        broadcastGameState()
        return
      }

      if (gamePhase.value === 'guessing') {
        logAction('advanced_guessing_to_selecting_winners')
        debugSnapshot('after_switch_selecting_winners')
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
        const nextTurn =
          ((gameState.value.currentTurn || 0) + 1) % (gameState.value.players.length || 1)
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

        // Завершаем игру после превышения лимита раундов
        if (currentRound.value > TOTAL_ROUNDS) {
          gamePhase.value = 'game_over'
          gameState.value.phase = 'game_over'
        } else {
    // Синхронизируем snapshot активной колоды для UI
    const activeDeckRef = currentMode.value === 'basic' ? basicDeck : advancedDeck
    gameState.value.questionIndices = activeDeckRef.value.slice()
    gamePhase.value = 'drawing_question'
    gameState.value.phase = 'drawing_question'
        }
        broadcastGameState()
        return
      }
    }
  }
  // Состояние игры
  const gameState = ref<
    GameState & {
      currentQuestion?: number | null
      votes?: Record<string, string[]>
      bets?: Record<string, string>
      stateVersion?: number
    }
  >({
    roomId: '',
    gameStarted: false,
    players: [],
    litUpPlayerId: null,
    maxPlayers: GAME_CONFIG.MAX_PLAYERS,
    hostId: '',
    createdAt: 0,
    votingCards: {},
    bettingCards: {},
    currentTurn: 0,
    scores: {},
    currentQuestion: null,
    votes: {},
    bets: {},
    stateVersion: 1,
  })

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
          {
            roomId: roomId.value || gameState.value.roomId,
            version,
            receivedAt: Date.now(),
          } as any,
          {
            roomId: roomId.value || gameState.value.roomId,
            fromId: myPlayerId.value,
            ts: Date.now(),
          },
        ),
      )
    } catch {}
  }

  function requestResync(fromVersion?: number) {
    try {
      peerService.broadcastMessage(
        makeMessage(
          'resync_request' as any,
          {
            roomId: roomId.value || gameState.value.roomId,
            fromVersion,
            reason: initReceived.value ? 'gap' : 'init_missing',
          } as any,
          {
            roomId: roomId.value || gameState.value.roomId,
            fromId: myPlayerId.value,
            ts: Date.now(),
          },
        ),
      )
    } catch {}
  }

  const myNickname = ref<string>('')
  const isHost = ref<boolean>(false)
  const hostId = ref<string>('')
  const roomId = ref<string>('')
  const connectionStatus = ref<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const restorationState = ref<'idle' | 'discovering' | 'restoring'>('idle')
  // Черный список «мертвых» кандидатов-хостов на короткое время, чтобы не зациклиться на недоступном id
  const deadHostBlacklist = new Map<string, number>() // hostId -> untilTs
  const DEAD_HOST_TTL_MS = 10_000
  // Метка последней успешной сессии/подключения
  const sessionTimestamp = ref<number | null>(null)

  // Computed
  // Кнопка "Начать" должна быть активна для хоста при >=3 игроках и если игра еще не запущена
  // Также учитываем восстановление состояния: если мы хост и phase === 'lobby', разрешаем старт независимо от gameStarted флага,
  // так как он может быть не синхронизирован в начальный момент.
  const canStartGame = computed(() => {
    // Правило: стартовать можно только из лобби и только хосту. Минимум 3 игрока, чтобы не зависать в ожидании.
    const isLobby = (gameState.value.phase ?? 'lobby') === 'lobby'
    const enoughPlayers = gameState.value.players.length >= GAME_CONFIG.MIN_PLAYERS
    return isHost.value && isLobby && enoughPlayers
  })

  const myPlayer = computed(() => gameState.value.players.find((p) => p.id === myPlayerId.value))

  const canJoinRoom = computed(
    () =>
      gameState.value.players.length < gameState.value.maxPlayers || !gameState.value.gameStarted,
  )

  // Определение цвета по индексy присоединения (детерминированно, циклически)
  const getColorByIndex = (index: number): string => {
    return PLAYER_COLORS[index % PLAYER_COLORS.length]
  }

  // Генерация никнейма по умолчанию
  const generateDefaultNickname = (): string => {
    return `${NICKNAME_PREFIX}${Math.floor(Math.random() * 9999)}`
  }

  // Генерация читаемого ID комнаты
  const generateRoomId = (): string => {
    const numbers = Math.floor(Math.random() * 100)

    const adjective = ROOM_ID_WORDS.adjectives[Math.floor(Math.random() * ROOM_ID_WORDS.adjectives.length)]
    const noun = ROOM_ID_WORDS.nouns[Math.floor(Math.random() * ROOM_ID_WORDS.nouns.length)]

    return `${adjective}-${noun}-${numbers}`
  }

  // Устойчивое хранение roomId между перезагрузками хоста (storageSafe, namespace 'game')
  const savePersistentRoomId = (rid: string) => {
    try {
      storageSafe.nsSet('game', 'roomIdStable', rid)
    } catch {}
  }
  const loadPersistentRoomId = (): string | null => {
    try {
      return storageSafe.nsGet<string>('game', 'roomIdStable')
    } catch {
      return null
    }
  }
  const clearPersistentRoomId = () => {
    try {
      storageSafe.nsRemove('game', 'roomIdStable')
    } catch {}
  }

  // Устойчивый идентификатор игрока для переподключений (не равен текущему peer id, это «якорь» прошлой сессии)
  const saveStablePlayerId = (pid: string) => {
    try {
      storageSafe.nsSet('game', 'playerIdStable', pid)
    } catch {}
  }
  const loadStablePlayerId = (): string | null => {
    try {
      return storageSafe.nsGet<string>('game', 'playerIdStable')
    } catch {
      return null
    }
  }
  const clearStablePlayerId = () => {
    try {
      storageSafe.nsRemove('game', 'playerIdStable')
    } catch {}
  }

  // Генерация токена безопасности
  const generateAuthToken = (playerId: string, roomId: string, timestamp: number): string => {
    const data = `${playerId}-${roomId}-${timestamp}-${Math.random()}`
    // Простая хеш-функция для создания токена
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i)
      hash = (hash << 5) - hash + char
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
    // --- Очищаем localStorage кроме nickname ---
    const savedNick = getNickname();
    localStorage.clear();
    if (savedNick) localStorage.setItem('nickname', savedNick);

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
        peerService.setCurrentHostId(restoredPeerId)
        gameState.value = { ...existingSession.gameState }
        gameState.value.hostId = restoredPeerId

        // Обновляем мой ID в списке игроков
        const myPlayerIndex = gameState.value.players.findIndex((p: Player) => p.isHost)
        if (myPlayerIndex !== -1) {
          gameState.value.players[myPlayerIndex].id = restoredPeerId
          gameState.value.players[myPlayerIndex].nickname = nickname
        }

        connectionStatus.value = 'connected'
        peerService.setRoomContext(targetRoomId || gameState.value.roomId || (null as any))
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
        peerService.setCurrentHostId(restoredPeerId)

        gameState.value = {
          roomId: targetRoomId,
          gameStarted: false,
          players: [],
          litUpPlayerId: null,
          maxPlayers: GAME_CONFIG.MAX_PLAYERS,
          hostId: restoredPeerId,
          createdAt: now,
          votingCards: {},
          bettingCards: {},
          currentTurn: 0,
          scores: {},
          currentQuestion: null,
          votes: {},
          bets: {},
          answers: {},
          guesses: {},
        }

        // Добавляем хоста в список игроков
        const hostPlayer: Player = {
          id: restoredPeerId,
          nickname,
          color: getColorByIndex(0),
          isHost: true,
          joinedAt: now,
          authToken: generateAuthToken(restoredPeerId, targetRoomId, now),
          votingCards: [...DEFAULT_CARDS.voting],
          bettingCards: [...DEFAULT_CARDS.betting],
        }

        gameState.value.players = [hostPlayer]
      }

      connectionStatus.value = 'connected'
      // Синхронизируем устойчивый roomId
      if (roomId.value) savePersistentRoomId(roomId.value)

      // Устанавливаем роль хоста и запускаем heartbeat
      peerService.setRoomContext(targetRoomId || gameState.value.roomId || (null as any))
      peerService.setAsHost(restoredPeerId, targetRoomId || gameState.value.roomId)
      setupHostMessageHandlers()
      // Сохраняем roomId для последующих перезагрузок
      savePersistentRoomId(targetRoomId)

      // Сохранение атомарных полей выполняет Pinia persist; устойчивый roomId уже сохранен
      try {
      } catch {}

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
    // --- Очищаем localStorage кроме nickname ---
    const savedNick = getNickname();
    localStorage.clear();
    if (savedNick) localStorage.setItem('nickname', savedNick);

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
      
      // КРИТИЧНО: Устанавливаем currentHostId в peerService для корректной обработки отключения хоста
      peerService.setCurrentHostId(targetHostId)

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
            savedPlayerId: stableId,
          },
          {
            roomId: roomId.value || gameState.value.roomId || '',
            fromId: myPlayerId.value,
            ts: Date.now(),
          } as MessageMeta,
        ),
      )

      // 5) Идемпотентный запрос актуального состояния, чтобы гарантированно получить список игроков
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          {
            roomId: roomId.value || gameState.value.roomId || '',
            fromId: myPlayerId.value,
            ts: Date.now(),
          },
        ),
      )

      // Note: peer list request removed - no longer needed in hub-and-spoke architecture

      // 7) Дожидаемся быстрого обновления состояния (используем уже существующую утилиту)
      try {
        await waitForGameStateUpdate()
      } catch {}

      // 8) Теперь считаем соединение установленным
      connectionStatus.value = 'connected'

      // Сохранение атомарных полей выполняет Pinia persist
      try {
      } catch {}
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
    peerService.onMessage('heartbeat', (message: PeerMessage) => {
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
    peerService.onMessage('user_left_room', (message: PeerMessage, conn: any) => {
      if (!isHost.value) return
      const typed = message as Extract<PeerMessage, { type: 'user_left_room' }>
      const { userId, roomId: rid, timestamp, currentScore, reason } = typed.payload

      // Валидация комнаты
      if (rid && gameState.value.roomId && rid !== gameState.value.roomId) {
        console.log('❌ Ignoring user_left_room for different room', {
          rid,
          current: gameState.value.roomId,
        })
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
        reason: reason || 'explicit_leave',
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
              nv[k] = (v || []).filter((t) => t !== userId)
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
            const nextIndex = gameState.value.currentTurn
              ? gameState.value.currentTurn % players.length
              : 0
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
            reason: reason || 'explicit_leave',
          },
          { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() },
        ),
      )

      // Обновляем основное состояние игры для всех
      broadcastGameState()
    })

    peerService.onMessage('join_request', (message: PeerMessage, conn: any) => {
      console.log('Host received join_request:', {
        payload: message.payload,
        connPeer: conn?.peer,
        canJoinRoom: canJoinRoom.value,
        currentPlayers: gameState.value.players.length,
        maxPlayers: gameState.value.maxPlayers,
        gameStarted: gameState.value.gameStarted,
      })

      if (!conn) {
        console.log('No connection provided to join_request')
        return
      }

      if (!canJoinRoom.value) {
        console.log('Cannot join room:', {
          currentPlayers: gameState.value.players.length,
          maxPlayers: gameState.value.maxPlayers,
          gameStarted: gameState.value.gameStarted,
        })
        return
      }

      const { nickname } = (message as Extract<PeerMessage, { type: 'join_request' }>).payload

      // Сначала проверяем, не подключен ли уже этот игрок по ID
      const existingPlayerById = gameState.value.players.find((p) => p.id === conn.peer)
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
        currentPlayers: gameState.value.players.map((p: Player) => ({
          id: p.id,
          nickname: p.nickname,
          isHost: p.isHost,
        })),
        currentLitUpPlayerId: gameState.value.litUpPlayerId,
      })

      if (savedPlayerId) {
        console.log('🔍 HOST: Checking for existing player by savedPlayerId:', {
          savedPlayerId,
          hasPayloadSavedId: !!savedPlayerId,
          currentPlayers: gameState.value.players.map((p: Player) => ({
            id: p.id,
            nickname: p.nickname,
            isHost: p.isHost,
          })),
          currentLitUpPlayerId: gameState.value.litUpPlayerId,
        })

        // Проверяем, не пытается ли текущий хост переподключиться (что не должно происходить)
        if (savedPlayerId === gameState.value.hostId) {
          console.log('🛑 Saved ID belongs to current host. This should not happen during normal operation:', {
            savedPlayerId,
            currentHostId: gameState.value.hostId,
            requester: conn.peer,
          })
          // Отвечаем отказом в легкой форме: отправим краткий state
          try {
            const minimalState = {
              hostId: gameState.value.hostId,
              roomId: gameState.value.roomId,
              players: gameState.value.players,
            }
            peerService.sendMessage(
              conn.peer,
              makeMessage('game_state_update', minimalState as any, {
                roomId: gameState.value.roomId,
                fromId: gameState.value.hostId,
                ts: Date.now(),
              }),
            )
          } catch {}
          return
        }

        const existingPlayerBySavedId = gameState.value.players.find(
          (p) => p.id === savedPlayerId && !p.isHost,
        )
        console.log('🔍 HOST: Search result for existing player:', {
          existingPlayerFound: !!existingPlayerBySavedId,
          existingPlayer: existingPlayerBySavedId
            ? {
                id: existingPlayerBySavedId.id,
                nickname: existingPlayerBySavedId.nickname,
              }
            : null,
        })

        if (existingPlayerBySavedId) {
          console.log('✅ HOST: Found existing player by saved ID, updating connection:', {
            savedId: savedPlayerId,
            newConnectionId: conn.peer,
            nickname: nickname,
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
            console.log('🔄 HOST: Updating currentTurnPlayerId from old ID to new ID:', {
              oldId,
              newId,
            })
            gameState.value.currentTurnPlayerId = newId
          }

          // 3) votes (ключи)
          if (gameState.value.votes) {
            const newVotes: Record<string, string[]> = {}
            Object.entries(gameState.value.votes).forEach(([k, v]) => {
              const mappedKey = k === oldId ? newId : k
              // также заменим внутри массивов целевые ID, если кто-то голосовал за oldId
              const mappedArray = (v || []).map((t) => (t === oldId ? newId : t))
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
          if (
            Array.isArray(gameState.value.roundWinners) &&
            gameState.value.roundWinners.length > 0
          ) {
            gameState.value.roundWinners = gameState.value.roundWinners.map((pid) =>
              pid === oldId ? newId : pid,
            )
          }

          // 9) answeringPlayerId
          if (gameState.value.answeringPlayerId === oldId) {
            gameState.value.answeringPlayerId = newId
          }

          // Обновляем ID и токен игрока в players
          existingPlayerBySavedId.id = newId
          existingPlayerBySavedId.nickname = nickname
          existingPlayerBySavedId.authToken = generateAuthToken(
            newId,
            gameState.value.roomId,
            Date.now(),
          )

          console.log('🎯 HOST: Broadcasting updated game state with full ID remap:', {
            updatedPlayer: {
              id: existingPlayerBySavedId.id,
              nickname: existingPlayerBySavedId.nickname,
            },
            newLitUpPlayerId: gameState.value.litUpPlayerId,
            newCurrentTurnPlayerId: gameState.value.currentTurnPlayerId,
            totalPlayers: gameState.value.players.length,
          })

          // Presence: помечаем игрока как present при успешном ремапе
          const nowTs = Date.now()
          if (!gameState.value.presence) gameState.value.presence = {}
          if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
          gameState.value.presence[newId] = 'present'
          gameState.value.presenceMeta[newId] = {
            lastSeen: Math.max(nowTs, gameState.value.presenceMeta[newId]?.lastSeen || 0),
          }
          // Чистим возможные старые метки отсутствия
          delete (gameState.value.presenceMeta[newId] as any).leftAt
          delete (gameState.value.presenceMeta[newId] as any).reason

          // Broadcast о присоединении (для ARIA/тостов)
          peerService.broadcastMessage(
            makeMessage(
              'user_joined_broadcast',
              { userId: newId, roomId: gameState.value.roomId, timestamp: nowTs },
              { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: nowTs },
            ),
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
                message: 'Your player ID has been updated due to reconnection',
              },
              { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() },
            ),
          )

          console.log(
            '✅ HOST: Updated existing player and sent ID update notification:',
            existingPlayerBySavedId,
          )
          return
        } else {
          console.log(
            '❌ HOST: No existing player found with savedPlayerId, will create new player',
          )
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
        votingCards: [...DEFAULT_CARDS.voting],
        bettingCards: [...DEFAULT_CARDS.betting],
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

      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся что хост имеет правильный флаг isHost
      const currentHost = gameState.value.players.find(p => p.id === gameState.value.hostId)
      if (currentHost) {
        currentHost.isHost = true
        console.log('🔄 HOST: Confirmed host flag for:', currentHost.nickname, currentHost.id)
      }
      
      // Убеждаемся что у всех остальных isHost = false
      gameState.value.players.forEach(p => {
        if (p.id !== gameState.value.hostId) {
          p.isHost = false
        }
      })

      // Отправляем обновленное состояние всем игрокам
      broadcastGameState()

      // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Принудительно отправляем обновленное состояние каждому существующему клиенту
      // чтобы гарантировать, что все видят нового игрока (Player A2)
      const existingClients = gameState.value.players.filter(p => p.id !== newPlayer.id && p.id !== gameState.value.hostId)
      console.log('🔄 HOST: Forcing individual state updates to existing clients:', existingClients.map(p => p.id))
      
      // Сначала убеждаемся что у хоста есть соединения со всеми клиентами
      const connectedPeers = peerService.getConnectedPeers()
      console.log('🔗 HOST: Current connections:', connectedPeers)
      
      // Пытаемся отправить состояние всем клиентам с повторными попытками
      const sendWithRetry = async (clientId: string, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const hasConnection = peerService.getConnectedPeers().includes(clientId)
            console.log(`🔍 HOST: Attempt ${attempt}/${retries} - Connection to ${clientId}: ${hasConnection}`)
            
            if (hasConnection) {
              peerService.sendMessage(
                clientId,
                makeMessage('game_state_update', { ...gameState.value }, {
                  roomId: gameState.value.roomId,
                  fromId: gameState.value.hostId,
                  ts: Date.now(),
                })
              )
              console.log(`✅ HOST: Sent individual state update to client ${clientId} (attempt ${attempt})`)
              return // Success
            } else if (attempt < retries) {
              console.log(`⏳ HOST: No connection to ${clientId}, waiting for mesh sync...`)
              await new Promise(resolve => setTimeout(resolve, 500)) // Wait 500ms before retry
            }
          } catch (e) {
            console.warn(`❌ HOST: Failed to send individual state update to client ${clientId} (attempt ${attempt}):`, e)
            if (attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, 500)) // Wait before retry
            }
          }
        }
        console.warn(`⚠️ HOST: Exhausted retries for client ${clientId}, relying on mesh protocol`)
      }
      
      // Отправляем обновления асинхронно всем клиентам
      existingClients.forEach(client => {
        sendWithRetry(client.id).catch(e => {
          console.warn(`Failed to send retry updates to ${client.id}:`, e)
        })
      })
      
      // ДОПОЛНИТЕЛЬНО: Попытка использовать mesh-соединения для доставки обновлений  
      // если прямые соединения хост->клиент не работают
      setTimeout(() => {
        console.log('🕸️ HOST: Attempting mesh-based state propagation as fallback')
        try {
          // Просим присоединившегося игрока помочь с рассылкой обновлений через mesh
          const meshPropagationMessage = makeMessage('state_sync', {
            gameState: { ...gameState.value },
            timestamp: Date.now(),
            fromPlayerId: gameState.value.hostId,
            version: 1
          }, {
            roomId: gameState.value.roomId,
            fromId: gameState.value.hostId,
            ts: Date.now(),
          })
          
          peerService.sendMessage(conn.peer, meshPropagationMessage)
          console.log('🕸️ HOST: Sent state_sync to new player for mesh propagation')
        } catch (e) {
          console.warn('🕸️ HOST: Failed to send mesh propagation message:', e)
        }
      }, 1000) // Задержка для установки mesh-соединений

      // Unicast: сразу отправляем присоединившемуся игроку актуальный снапшот (гарантированный первичный снимок)
      try {
        const snapshot = { ...gameState.value }
        peerService.sendMessage(
          conn.peer,
          makeMessage('game_state_update', snapshot, {
            roomId: gameState.value.roomId,
            fromId: gameState.value.hostId,
            ts: Date.now(),
          }),
        )
      } catch (e) {
        console.warn('Failed to unicast initial snapshot to new player', {
          peer: conn.peer,
          error: e,
        })
      }

      // Broadcast о присоединении (для ARIA/тостов у всех)
      peerService.broadcastMessage(
        makeMessage(
          'user_joined_broadcast',
          { userId: newPlayer.id, roomId: gameState.value.roomId, timestamp: now },
          { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: now },
        ),
      )

      console.log(
        'Updated players list:',
        gameState.value.players.map((p: Player) => ({ id: p.id, nickname: p.nickname })),
      )

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
              latestVersion: currentVersion?.value ?? 0,
            } as any,
            { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() },
          ),
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
                  serverTime: nowTs,
                },
                state: { ...gameState.value },
              } as any,
              { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: nowTs },
            ),
          )
        } catch (e) {
          console.warn('Failed to send authoritative state_snapshot to new player', e)
        }
      } catch (e) {
        console.warn('Failed to send join_ok', e)
      }
    })

    peerService.onMessage('light_up_request', (message: PeerMessage) => {
      const typed = message as Extract<PeerMessage, { type: 'light_up_request' }>
      console.log('🔥 HOST: Received light_up_request:', typed.payload)
      const { playerId } = typed.payload

      console.log('🔍 HOST: Processing light_up_request:', {
        requestedPlayerId: playerId,
        gameStarted: gameState.value.gameStarted,
        currentPlayers: gameState.value.players.map((p: any) => ({
          id: p.id,
          nickname: p.nickname,
        })),
        playerExists: gameState.value.players.some((p: any) => p.id === playerId),
        currentLitUpPlayerId: gameState.value.litUpPlayerId,
      })

      if (gameState.value.gameStarted) {
        const playerExists = gameState.value.players.some((p: any) => p.id === playerId)

        if (playerExists) {
          console.log('✅ HOST: Processing light up for valid player:', playerId)
          gameState.value.litUpPlayerId = playerId

          console.log('📢 HOST: Broadcasting light up state:', {
            litUpPlayerId: gameState.value.litUpPlayerId,
            totalPlayers: gameState.value.players.length,
            playersInState: gameState.value.players.map((p: any) => ({
              id: p.id,
              nickname: p.nickname,
            })),
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
            availablePlayers: gameState.value.players.map((p: any) => p.id),
          })
        }
      } else {
        console.log('❌ HOST: Game not started, ignoring light_up_request')
      }
    })

    // Необязательный обработчик ACK'а состояния — убирает шум в логах и может пригодиться для телеметрии готовности клиентов
    peerService.onMessage('state_ack' as any, (message: PeerMessage) => {
      try {
        const payload = (message as any).payload || {}
        console.log('📥 RECEIVED state_ack from client:', payload)
      } catch {}
    })

    peerService.onMessage('request_game_state', (message: PeerMessage, conn: any) => {
      if (!conn) return

      const req = (message as Extract<PeerMessage, { type: 'request_game_state' }>).payload as any
      console.log('Host sending game state to client:', conn.peer, 'request:', req, {
        players: gameState.value.players.map((p: Player) => ({
          id: p.id,
          nickname: p.nickname,
          isHost: p.isHost,
        })),
        roomId: gameState.value.roomId,
        hostId: gameState.value.hostId,
        phase: (gameState.value.phase ?? gamePhase.value) || 'lobby',
      })

      // Перед отправкой убеждаемся, что phase/gameMode синхронизированы с локальными рефами
      gameState.value.phase = gamePhase.value
      gameState.value.gameMode = gameMode.value

      const snapshot = { ...gameState.value }

      // 1) Legacy: отправляем game_state_update (совместимость)
      peerService.sendMessage(
        conn.peer,
        makeMessage('game_state_update', snapshot, {
          roomId: snapshot.roomId,
          fromId: snapshot.hostId,
          ts: Date.now(),
        }),
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
                serverTime: nowTs,
              },
              state: snapshot,
            } as any,
            { roomId: snapshot.roomId, fromId: snapshot.hostId, ts: nowTs },
          ),
        )
        console.log(
          '🔼 Host sent state_snapshot in response to request_game_state to:',
          conn.peer,
          {
            version: currentVersion.value || 0,
            players: snapshot.players.length,
            phase: snapshot.phase,
            roomId: snapshot.roomId,
          },
        )
      } catch (e) {
        console.warn('Failed to send authoritative state_snapshot (request_game_state)', e)
      }
    })

    // -------- Игровые сообщения от клиентов к хосту --------

    // Вытягивание вопроса — разрешено только текущему игроку в фазе drawing_question
    peerService.onMessage('draw_question_request', async (message: PeerMessage, conn: any) => {
      const requesterId =
        conn?.peer ||
        (message as Extract<PeerMessage, { type: 'draw_question_request' }>).payload?.playerId
      console.log(
        'HOST: draw_question_request from',
        requesterId,
        'phase:',
        gamePhase.value,
        'currentTurnPlayerId:',
        gameState.value.currentTurnPlayerId,
      )
      if (!isHost.value) return
      if (gamePhase.value !== 'drawing_question') return
      if (!requesterId) return

      // Передаём requesterId внутрь drawCard для точной проверки
      const card = await drawCard(requesterId)
      if (!card) {
        console.log('Ignored draw_question_request: not allowed or no cards left')
        return
      }
      // drawCard уже делает broadcast
    })

    // Переход к следующей фазе/раунду — доступно ЛЮБОМУ игроку после консенсуса
    peerService.onMessage('next_round_request', (message: PeerMessage, conn: any) => {
      if (!isHost.value) return
      // Разрешаем кнопку только в фазах результатов
      if (gamePhase.value !== 'results' && gamePhase.value !== 'advanced_results') return

      // Поддержка принудительного пропуска от клиента
      const m = message as Extract<PeerMessage, { type: 'next_round_request' }>
      const force = Boolean((m as any).payload?.force)

      // Проверка консенсуса: все должны завершить свои действия (голос/ставка/догадка)
      const totalPlayers = gameState.value.players.length

      if (!force) {
        if ((gameState.value.gameMode ?? gameMode.value) === 'basic') {
          const allVoted = Object.keys(gameState.value.votes || {}).length >= totalPlayers
          const allBet = Object.keys(gameState.value.bets || {}).length >= totalPlayers
          const resultsReady = gamePhase.value === 'results' // уже посчитаны очки
          if (!(allVoted && allBet && resultsReady)) return
        } else {
          // advanced
          const votedCount = Object.keys(gameState.value.votes || {}).length
          const guessesCount = Object.keys(gameState.value.guesses || {}).filter(
            (pid) => pid !== gameState.value.answeringPlayerId,
          ).length
          const requiredGuesses = Math.max(0, totalPlayers - 1)
          const resultsReady = gamePhase.value === 'advanced_results'
          if (!(votedCount >= totalPlayers && guessesCount >= requiredGuesses && resultsReady))
            return
        }
      }

      // Выполняем переход хода/сброс раундовых данных
      finishRoundHostOnly(force)
    })

    // Очередь для обработки голосов
    const voteQueue: Array<() => Promise<void>> = []
    let voteProcessing = false

    async function processVoteQueue() {
      if (voteProcessing) return
      voteProcessing = true
      while (voteQueue.length > 0) {
        const fn = voteQueue.shift()
        if (fn) {
          await fn()
        }
      }
      voteProcessing = false
    }

    // Секретные/обычные голоса
    peerService.onMessage('submit_vote', (message: PeerMessage, conn: any) => {
      if (!isHost.value) return
      voteQueue.push(async () => {
        // Поддерживаем оба формата: targetIds (новый) и votes (старый)
        const m = message as Extract<PeerMessage, { type: 'submit_vote' }>
        const voterId = (m.payload as any)?.voterId
        const rawVotes = (m.payload as any)?.targetIds ?? (m.payload as any)?.votes
        const stateVersion = (m.payload as any)?.stateVersion
        if (!voterId || !Array.isArray(rawVotes)) return
        if (gamePhase.value !== 'voting' && gamePhase.value !== 'secret_voting') return

        // Проверка версии состояния
        if (
          typeof stateVersion === 'number' &&
          typeof gameState.value.stateVersion === 'number' &&
          stateVersion !== gameState.value.stateVersion
        ) {
          // Версия не совпадает — отправляем ошибку клиенту
          if (conn) {
            peerService.sendMessage(
              conn.peer,
              makeMessage(
                'connection_error',
                {
                  code: 'version_mismatch',
                  message: 'Версия состояния не совпадает',
                },
                {
                  roomId: gameState.value.roomId,
                  fromId: gameState.value.hostId,
                  ts: Date.now(),
                },
              ),
            )
          }
          return
        }

        // Нормализуем массив голосов (макс 2, уникальные и не голосуем за себя)
        const uniqueVotes = Array.from(new Set(rawVotes)).slice(0, 2)
        const validVotes = uniqueVotes.filter((id) => id && id !== voterId)

        if (!gameState.value.votes) gameState.value.votes = {}
        gameState.value.votes[voterId] = validVotes

        // --- Отправляем подтверждение клиенту ---
        if (conn) {
          peerService.sendMessage(
            conn.peer,
            makeMessage(
              'vote_ack',
              { voterId, targetIds: validVotes },
              {
                roomId: gameState.value.roomId,
                fromId: gameState.value.hostId,
                ts: Date.now(),
              },
            ),
          )
        }

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
            gameState.value.players.forEach((p) => {
              if (gameState.value.bets![p.id] === undefined) {
                // ничего не присваиваем, просто убеждаемся, что объект существует
              }
            })

            broadcastGameState()
          } else {
            // advanced: переход из secret_voting в answering выполняем ОДИН РАЗ по факту завершения голосования
            // Защита от двойного перехода/гонок
            if (gamePhase.value !== 'secret_voting') {
              return
            }
            if (gameState.value.answeringPlayerId) {
              return
            }

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
      processVoteQueue()
    })

    // Ставки в basic
    peerService.onMessage('submit_bet', (message: PeerMessage, conn: any) => {
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
        console.log('🚫 BETTING: Duplicate bet ignored for player:', playerId)
        return
      }

      gameState.value.bets[playerId] = bet
      console.log('💰 BETTING: Bet received from player:', playerId, 'bet:', bet)

      const playersCount = gameState.value.players.length
      const betsCount = Object.keys(gameState.value.bets).length
      console.log('💰 BETTING: Bets progress:', betsCount, '/', playersCount)

      if (betsCount >= playersCount) {
        // Все поставили — считаем раунд и в results
        console.log('💰 BETTING: All players bet, transitioning to results')
        processRound()
        gamePhase.value = 'results'
        gameState.value.phase = 'results'
        console.log('💰 BETTING: Transitioned to results phase')
      }

      // Важно: сразу рассылаем обновленное состояние, чтобы у клиента отобразилась выбранная ставка
      broadcastGameState()
      console.log('💰 BETTING: State broadcasted')
    })

    // Ответ отвечающего (advanced)
    peerService.onMessage('submit_answer', (message: PeerMessage, conn: any) => {
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
    peerService.onMessage('submit_guess', (message: PeerMessage, conn: any) => {
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
      const guessesCount = Object.keys(gameState.value.guesses).filter(
        (pid) => pid !== gameState.value.answeringPlayerId,
      ).length

      // Когда получили все догадки, ПЕРЕХОДИМ В selecting_winners, без начисления очков
      if (guessesCount >= requiredGuesses) {
        gamePhase.value = 'selecting_winners'
        gameState.value.phase = 'selecting_winners'
        if (!gameState.value.roundWinners) gameState.value.roundWinners = []
      }

      broadcastGameState()
    })

    // Обработка выбора победителей в advanced от клиента (строгая авторизация: только автор ответа)
    peerService.onMessage('submit_winners', (message: PeerMessage) => {
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
        rawWinners.filter(
          (id) =>
            id &&
            id !== chooserId &&
            !!(gameState.value.guesses && gameState.value.guesses[id] !== undefined) &&
            gameState.value.players.some((p) => p.id === id),
        ),
      )
      const winners = Array.from(validSet)

      // Применяем логику начисления и перехода фазы
      submitWinners(winners)
    })

    // Добавляем обработчики host discovery
    setupHostDiscoveryHandlers()

    // Добавляем обработчики mesh-протокола
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
    peerService.onMessage('state_snapshot', (message: PeerMessage) => {
      if (isHost.value) return
      const payload = (message as Extract<PeerMessage, { type: 'state_snapshot' }>).payload as any
      const meta = payload?.meta
      console.log('📥 CLIENT received state_snapshot:', {
        meta,
        hasRoom: !!gameState.value.roomId,
        currentRoom: gameState.value.roomId || '(empty)',
        incomingRoom: meta?.roomId,
        playersInPayload: Array.isArray(payload?.state?.players)
          ? payload.state.players.length
          : -1,
        phase: payload?.state?.phase,
      })
      if (!meta || (gameState.value.roomId && meta.roomId !== gameState.value.roomId)) {
        console.warn('state_snapshot ignored due to room mismatch or missing meta')
        return
      }
      // Snapshot barrier: применяем целиком
      const incoming = { ...(payload.state || {}) }
      // Защита: синхронизируем ключевые поля
      if (incoming.hostId && !incoming.players?.some((p: Player) => p.id === incoming.hostId)) {
        console.warn(
          'Snapshot hostId not found among players, will keep as-is but UI may not highlight host',
        )
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
        phase: gameState.value.phase,
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

    peerService.onMessage('state_diff', (message: PeerMessage) => {
      if (isHost.value) return
      const payload = (message as Extract<PeerMessage, { type: 'state_diff' }>).payload as any
      const meta = payload?.meta
      console.log('📥 CLIENT received state_diff:', {
        meta,
        hasInit: initReceived.value,
        currentVersion: currentVersion.value,
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
    peerService.onMessage('user_joined_broadcast', (message: PeerMessage) => {
      const {
        userId,
        roomId: rid,
        timestamp,
      } = (message as Extract<PeerMessage, { type: 'user_joined_broadcast' }>).payload as any
      if (!gameState.value.presence) gameState.value.presence = {}
      if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
      gameState.value.presence[userId] = 'present'
      gameState.value.presenceMeta[userId] = {
        lastSeen: Math.max(
          timestamp || Date.now(),
          gameState.value.presenceMeta[userId]?.lastSeen || 0,
        ),
      }
      // Здесь позже будет UI: ARIA-live/тосты
    })

    peerService.onMessage('user_left_broadcast', (message: PeerMessage) => {
      const {
        userId,
        roomId: rid,
        timestamp,
        reason,
      } = (message as Extract<PeerMessage, { type: 'user_left_broadcast' }>).payload as any
      if (!gameState.value.presence) gameState.value.presence = {}
      if (!gameState.value.presenceMeta) gameState.value.presenceMeta = {}
      // Идемпотентно помечаем отсутствующим
      const ts = timestamp || Date.now()
      const prevMeta = gameState.value.presenceMeta[userId]
      const alreadyAbsent =
        gameState.value.presence?.[userId] === 'absent' && prevMeta?.leftAt && prevMeta.leftAt >= ts
      if (!alreadyAbsent) {
        gameState.value.presence[userId] = 'absent'
        gameState.value.presenceMeta[userId] = {
          lastSeen: Math.max(ts, prevMeta?.lastSeen || 0),
          leftAt: ts,
          reason: reason || 'explicit_leave',
        }
      }
      // ARIA уведомление
      ariaAnnounce('Пользователь покинул комнату')
    })

    // Обработчик уведомления о добровольном уходе хоста
    peerService.onMessage('host_left_room', (message: PeerMessage) => {
      if (isHost.value) return // Хост не обрабатывает собственные сообщения
      
      const { hostId: leftHostId, reason } = (message as Extract<PeerMessage, { type: 'host_left_room' }>).payload
      
      console.log('📢 CLIENT received host departure notification:', {
        leftHostId,
        reason,
        currentHostId: hostId.value,
        myId: myPlayerId.value
      })
      
      // Проверяем что это наш хост который уходит
      if (leftHostId === hostId.value) {
        console.log('🚪 Host left voluntarily - ending game for all players')
        
        // Хост ушел добровольно - игра заканчивается для всех
        endGameDueToHostLoss()
      }
    })


    peerService.onMessage('game_state_update', (message: PeerMessage) => {
      // Защита: принимаем только если мы клиент (у хоста истина в локальном состоянии)
      if (isHost.value) return

      const newState = {
        ...(message as Extract<PeerMessage, { type: 'game_state_update' }>).payload,
      }
      console.log('📥 CLIENT received game_state_update:', {
        players: Array.isArray(newState.players)
          ? newState.players.map((p: Player) => ({ id: p.id, nick: p.nickname }))
          : [],
        hostId: newState.hostId,
        roomId: newState.roomId,
        phase: newState.phase,
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
        console.log(
          '🆗 CLIENT accepted legacy game_state_update as initial snapshot (timeout fallback)',
        )
      }

      // Немедленно кешируем снапшот состояния, полученный от хоста, с TTL
      try {
        storageSafe.setWithTTL(
          'game',
          'hostGameStateSnapshot',
          { ts: Date.now(), state: newState },
          HOST_SNAPSHOT_TTL,
        )
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
          playersInState: newState.players.map((p: Player) => ({ id: p.id, nickname: p.nickname })),
          myPlayerId: myPlayerId.value,
          totalPlayers: newState.players.length,
        })

        const litUpPlayerExists = newState.players.some(
          (p: Player) => p.id === newState.litUpPlayerId,
        )
        if (!litUpPlayerExists) {
          console.log('🧹 Received invalid litUpPlayerId, clearing it:', {
            invalidId: newState.litUpPlayerId,
            availablePlayerIds: newState.players.map((p: Player) => p.id),
            playersWithNicknames: newState.players.map((p: Player) => ({
              id: p.id,
              nickname: p.nickname,
            })),
          })
          newState.litUpPlayerId = null
        } else {
          console.log('✅ litUpPlayerId is valid, keeping it:', newState.litUpPlayerId)
        }
      }

      // Отметим, что получили свежее состояние — можно останавливать ретраи
      try {
        gotFreshState.value = true
      } catch {}

      // Синхронизация критичных полей в локальные refs
      if (newState.hostId) hostId.value = newState.hostId
      if (newState.roomId) roomId.value = newState.roomId

      gameState.value = newState

      console.log('✅ CLIENT applied game_state_update:', {
        players: gameState.value.players.length,
        hostId: hostId.value,
        roomId: roomId.value,
        phase: gameState.value.phase,
      })
    })

    peerService.onMessage('player_id_updated', (message: PeerMessage) => {
      const {
        oldId,
        newId,
        message: updateMessage,
      } = (message as Extract<PeerMessage, { type: 'player_id_updated' }>).payload
      console.log('🔄 CLIENT: Received player_id_updated message:', {
        oldId,
        newId,
        updateMessage,
      })

      if (myPlayerId.value === oldId) {
        console.log('✅ CLIENT: Updating myPlayerId from old ID to new ID:', {
          oldId,
          newId,
        })
        myPlayerId.value = newId
        // КРИТИЧНО: обновляем устойчивый идентификатор
        try {
          saveStablePlayerId(newId)
        } catch {}
      } else {
        console.log('❌ CLIENT: Ignoring player_id_updated message - old ID does not match:', {
          currentId: myPlayerId.value,
          oldId,
        })
      }
    })

    peerService.onMessage('heartbeat', (message: PeerMessage) => {
      const { hostId: heartbeatHostId } = (message as Extract<PeerMessage, { type: 'heartbeat' }>)
        .payload
      peerService.handleHeartbeat(heartbeatHostId)
    })

    // Настройка callback для обнаружения отключения хоста
    peerService.onHostDisconnected(() => {
      onHostDisconnectedSafe()
    })

    // Миграция хоста удалена - теперь только переподключение

    // Добавляем обработчики host discovery
    setupHostDiscoveryHandlers()

    // Добавляем обработчики mesh-протокола
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
        storageSafe.setWithTTL(
          'game',
          'hostGameStateSnapshot',
          { ts: Date.now(), state: snapshot },
          HOST_SNAPSHOT_TTL,
        )
      } catch (e) {
        console.warn('Failed to persist host snapshot', e)
      }

      peerService.broadcastMessage(
        makeMessage('game_state_update', snapshot, {
          roomId: gameState.value.roomId,
          fromId: gameState.value.hostId,
          ts: Date.now(),
        }),
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
      connectionStatus: connectionStatus.value,
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
          {
            roomId: roomId.value || gameState.value.roomId,
            fromId: myPlayerId.value,
            ts: Date.now(),
          },
        ),
      )
    }
  }


  // Попытки переподключения к отключившемуся хосту
  const attemptReconnectionToHost = async (targetHostId: string) => {
    console.log('🔄 Attempting to reconnect to host:', targetHostId)

    const maxAttempts = 5
    const attemptInterval = 3000 // 3 секунды между попытками

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`🔍 Reconnection attempt ${attempt}/${maxAttempts} to host:`, targetHostId)

      try {
        // Перед повторной попыткой: быстрая проверка достижимости
        const reachable = await tryConnectToKnownHost(targetHostId)
        if (!reachable) {
          console.log('⛔ Host not reachable, break reconnection loop early')
          break
        }

        await peerService.connectToHost(targetHostId)

        // Если успешно - восстанавливаем состояние клиента
        peerService.setCurrentHostId(targetHostId)
        peerService.setAsClient()
        setupClientMessageHandlers()

        // Отправляем запрос на подключение с сохраненным устойчивым ID для повторного подключения
        peerService.sendMessage(
          targetHostId,
          makeMessage(
            'join_request',
            {
              nickname: myNickname.value,
              savedPlayerId: loadStablePlayerId() || myPlayerId.value,
            },
            {
              roomId: roomId.value || gameState.value.roomId,
              fromId: myPlayerId.value,
              ts: Date.now(),
            },
          ),
        )

        // Запрашиваем актуальное состояние игры
        peerService.sendMessage(
          targetHostId,
          makeMessage(
            'request_game_state',
            { requesterId: myPlayerId.value },
            {
              roomId: roomId.value || gameState.value.roomId,
              fromId: myPlayerId.value,
              ts: Date.now(),
            },
          ),
        )

        connectionStatus.value = 'connected'
        console.log('✅ Successfully reconnected to host:', targetHostId)
        return
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error('Failed to reconnect to host:', error.message)
        } else {
          console.error('An unknown error occurred during reconnection.')
        }
        console.log(`❌ Reconnection attempt ${attempt} failed`)
        if (attempt < maxAttempts) {
          console.log(`⏳ Waiting ${attemptInterval}ms before next attempt...`)
          await new Promise((resolve) => setTimeout(resolve, attemptInterval))
        }
      }
    }

    // Все попытки неудачны — не остаёмся в ложном состоянии, сразу запускаем универсальный discovery
    console.log('❌ All reconnection attempts failed. Starting universal discovery...')
    try {
      const discovered = await universalHostDiscovery({
        myPlayerId: myPlayerId.value,
        myNickname: myNickname.value,
        isHost: false,
        hostId: hostId.value,
        roomId: roomId.value,
        gameState: gameState.value,
      } as any)
      if (discovered) {
        console.log('🔁 Discovered new host after reconnection failures:', discovered.currentHostId)
        await reconnectToDiscoveredHost(discovered)
        return
      }
    } catch (e) {
      console.warn('Universal discovery after reconnection failures failed', e)
    }

    // Иначе — помечаем как отключено и передаём дальше по пайплайну (grace/migration)
    connectionStatus.value = 'disconnected'
  }

  // Мютекс для предотвращения дублирования попыток переподключения
  const reconnectionMutex = new Mutex()

  // Простая логика: если хост ушел добровольно - игра заканчивается, если сеть моргнула - переподключаемся
  const onHostDisconnectedSafe = async () => {
    // ПРОВЕРКА НА ДУБЛИРОВАНИЕ: Если переподключение уже идет, игнорируем новые вызовы
    if (reconnectionMutex.isLocked()) {
      console.log('🚫 HOST RECONNECTION: Already in progress, ignoring duplicate call')
      return
    }

    console.log('🔐 HOST RECONNECTION: Acquiring mutex lock')
    return await reconnectionMutex.runExclusive(async () => {
      console.log('✅ HOST RECONNECTION: Mutex acquired, starting reconnection process')
      
      // КРИТИЧНО: Проверяем не добровольный ли это выход
      if (isVoluntaryLeaving) {
        console.log('🚪 VOLUNTARY LEAVE: Skipping reconnection - player is leaving voluntarily')
        return
      }
      
      console.log('🚨 HOST DISCONNECTION DETECTED - attempting reconnection to same host')
      
      // Устанавливаем статус переподключения
      connectionStatus.value = 'connecting'
      
      const targetHostId = hostId.value || gameState.value.hostId
      
      if (!targetHostId) {
        console.error('❌ No host ID available for reconnection')
        endGameDueToHostLoss()
        return
      }

      // Попытки переподключения к тому же хосту (60 попыток = 1 минута)
      console.log('🔄 Starting reconnection attempts to host:', targetHostId, '(60 attempts, 1 second interval)')
      let reconnected = false
      
      for (let attempt = 1; attempt <= 60; attempt++) {
        try {
          console.log(`🔄 Reconnection attempt ${attempt}/60`)
          
          // Пытаемся переподключиться к тому же хосту
          await peerService.connectToHost(targetHostId)
          
          // Если успешно - восстанавливаем состояние клиента
          peerService.setCurrentHostId(targetHostId)
          peerService.setAsClient()
          setupClientMessageHandlers()

          // Отправляем запрос на подключение
          peerService.sendMessage(
            targetHostId,
            makeMessage(
              'join_request',
              {
                nickname: myNickname.value,
                savedPlayerId: myPlayerId.value,
              },
              {
                roomId: gameState.value.roomId,
                fromId: myPlayerId.value,
                ts: Date.now(),
              },
            ),
          )
          
          // Ждем проверки соединения
          await new Promise(resolve => setTimeout(resolve, 500))
          
          // Проверяем что соединение работает
          const currentRole = peerService.getCurrentRole()
          console.log(`🔍 Current peer role after connection attempt: ${currentRole}`)
          
          if (currentRole === 'client') {
            console.log(`✅ Successfully reconnected on attempt ${attempt}`)
            connectionStatus.value = 'connected'
            reconnected = true
            break
          } else {
            console.log(`❌ Connection failed, role is: ${currentRole}`)
          }
          
        } catch (error) {
          console.log(`❌ Attempt ${attempt} failed:`, error)
        }
        
        // Ждем 1 секунду перед следующей попыткой
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      
      if (!reconnected) {
        console.log('❌ All reconnection attempts failed after 1 minute. Host left voluntarily - ending game.')
        endGameDueToHostLoss()
      }
      
      console.log('🔓 HOST RECONNECTION: Releasing mutex lock')
    })
  }

  // Завершение игры из-за потери хоста
  const endGameDueToHostLoss = () => {
    console.log('🏁 Game ended due to host disconnection')
    
    // Очищаем состояние
    connectionStatus.value = 'disconnected'
    isHost.value = false
    hostId.value = ''
    
    // Показываем пользователю что игра закончилась
    // (здесь можно добавить показ модального окна или переход на главную)
    console.log('🏠 Returning to main menu due to host loss')
    
    // Очищаем соединения
    peerService.disconnect()
    
    // Сброс состояния игры
    leaveRoom().catch((err) => {
      console.warn('Error during leaveRoom:', err)
    })
    
    // Навигация на главную страницу
    console.log('🧭 Navigating to main menu...')
    router.push({ name: 'MainMenu' }).catch((err) => {
      console.warn('Navigation to main menu failed:', err)
    })
  }

  // Migration logic completely removed - using simple approach

  // Быстрый опрос хоста среди оставшихся игроков (используя основной peer)
  const quickHostDiscovery = async (
    players: Player[],
  ): Promise<HostDiscoveryResponsePayload | null> => {
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
        timestamp: Date.now(),
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
              payload: discoveryRequest,
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
        connectionsToCleanup.forEach((conn) => {
          // Закрываем только те соединения, которые НЕ были сохранены
          if (!peerService.hasConnection(conn.peer)) {
            try {
              console.log('Closing unsaved discovery connection:', conn.peer)
              conn.close()
            } catch (e) {
              /* ignore */
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
      gameState.value = { ...discoveredHost.gameState }

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
          { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() },
        ),
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
  // Migration functions removed - using simple approach

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
      validPlayers: (validPlayers as Player[]).map((p: Player) => ({
        id: p.id,
        nickname: p.nickname,
      })),
      sortedPlayers: (sortedPlayers as Player[]).map((p: Player) => ({
        id: p.id,
        nickname: p.nickname,
      })),
      selectedHost: sortedPlayers[0],
      myPlayerId: myPlayerId.value,
      amISelected: sortedPlayers[0].id === myPlayerId.value,
    })

    return sortedPlayers[0]
  }

  // All migration functions removed - using simple approach
  // If host leaves voluntarily: game ends immediately
  // If network drops: try reconnecting to the same host only

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
      const cached = storageSafe.getWithTTL<{ ts: number; state: GameState }>(
        'game',
        'hostGameStateSnapshot',
        null,
      )
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
        gameState: gameState.value,
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
        const canBeHost = !!(
          isHost.value &&
          (gameState.value.hostId === myPlayerId.value || !gameState.value.hostId)
        )
        if (canBeHost) {
          console.log('No active host found, becoming host (confirmed by anchor/pinia)...')
          isHost.value = true
          await restoreAsHost()
        } else {
          console.log(
            'No active host found and no authority to self-promote, retrying quick discovery...',
          )
          isHost.value = false
          hostId.value = ''
          const retryHost = await universalHostDiscovery({
            myPlayerId: myPlayerId.value,
            myNickname: myNickname.value,
            isHost: false,
            hostId: hostId.value,
            roomId: roomId.value,
            gameState: gameState.value,
          } as any)
          if (retryHost) {
            hostId.value = retryHost.currentHostId
            await restoreAsClient(retryHost.currentHostId)
          } else {
            connectionStatus.value = 'disconnected'
            restorationState.value = 'idle'
            console.log(
              'Staying disconnected: no authoritative host and not confirmed host self-promotion',
            )
            return false
          }
        }
      }

      // Успех восстановления только после подтверждённого подключения и получения состояния
      restorationState.value = 'idle'
      if (!gameState.value || !gameState.value.players || gameState.value.players.length === 0) {
        console.log('Session restore finished, but no valid state received — staying disconnected')
        connectionStatus.value = 'disconnected'
        endRequestError(
          'restoreSession',
          ridGuard,
          normalizeError('State not synced', 'restore_state_missing'),
        )
        return false
      }
      // Дополнительная валидация: если выбранный host недостижим — не ставим connected
      try {
        const currentHostId = hostId.value || gameState.value.hostId
        if (currentHostId) {
          const reachable = await tryConnectToKnownHost(currentHostId)
          if (!reachable) {
            console.log('Host unreachable on final validation. Marking disconnected.')
            connectionStatus.value = 'disconnected'
            endRequestError(
              'restoreSession',
              ridGuard,
              normalizeError('Host unreachable', 'host_unreachable'),
            )
            return false
          }
        }
      } catch {}
      connectionStatus.value = 'connected'
      console.log('Session successfully restored (validated by state and reachability)')
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
      // Debug
      isDebug,
      add: (id: string) => set.add(id),
      has: (id: string) => set.has(id),
    }
  }

  const universalHostDiscovery = async (
    sessionData: SessionData,
  ): Promise<HostDiscoveryResponsePayload | null> => {
    console.log('Starting universal host discovery...')

    const blacklist = createCandidateBlacklist()

    // Стратегия 1: Попытка подключения к последнему известному хосту (с валидацией достижимости)
    if (sessionData.hostId && sessionData.hostId !== sessionData.myPlayerId) {
      console.log(
        'Strategy 1: Trying to connect to last known host (validate reachability):',
        sessionData.hostId,
      )
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
    // ВАЖНО: опрашиваем И хост-флагов тоже, так как "isHost" в снепшоте может быть устаревшим после reload
    const savedPlayers = sessionData.gameState.players.filter(
      (p: Player) => p.id && p.id !== sessionData.myPlayerId,
    )
    if (savedPlayers.length > 0) {
      console.log(
        'Strategy 2: Polling saved players (including previous host flag as stale):',
        savedPlayers.map((p: Player) => p.id),
      )
      const discoveredFromPlayers = await quickHostDiscovery(savedPlayers)
      if (discoveredFromPlayers) {
        return discoveredFromPlayers
      }
      // Добавим всех недоступных из savedPlayers в блэклист по месту (quickHostDiscovery сам очищает свои временные коннекты;
      // если хоста не нашли, значит ни один не подтвердил себя как хост)
      savedPlayers.forEach((p) => blacklist.add(p.id))
    }

    // Стратегия 3: Детерминированный кандидат по минимальному id среди ИЗВЕСТНЫХ игроков,
    // НО только если он достижим (короткая проверка доступности). Исключаем последний недоступный hostId.
    const knownPlayers = (gameState.value.players || []).filter(
      (p) => !!p && p.id && p.id !== sessionData.myPlayerId,
    )
    const sortedById = [...knownPlayers].sort((a, b) => a.id.localeCompare(b.id))

    for (const candidate of sortedById) {
      if (blacklist.has(candidate.id)) {
        console.log('Skip blacklisted deterministic candidate:', candidate.id)
        continue
      }
      // Не выбираем последнего недоступного hostId повторно
      if (sessionData.hostId && candidate.id === sessionData.hostId) {
        console.log('Skip last unreachable hostId as deterministic candidate:', candidate.id)
        continue
      }
      console.log(
        'Universal host discovery fallback trying deterministic candidate (reachability check):',
        candidate.id,
      )
      const reachable = await tryConnectToKnownHost(candidate.id)
      if (reachable) {
        console.log('Deterministic candidate reachable, selecting as host:', candidate.id)
        return {
          responderId: candidate.id,
          responderToken: candidate.authToken || '',
          isHost: false,
          currentHostId: candidate.id,
          gameState: gameState.value,
          timestamp: Date.now(),
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
  const discoverActiveNetwork = async (
    sessionData: SessionData,
  ): Promise<HostDiscoveryResponsePayload | null> => {
    console.log('Discovering active network for room:', sessionData.roomId)

    // Используем тот же алгоритм что и в universalHostDiscovery
    return await universalHostDiscovery(sessionData)
  }

  // Попытка подключения к известному хосту
  // Проверка достижимости конкретного peer как хоста.
  // ВАЖНО: используем существующий peer, если он уже создан, чтобы избежать гонок и множественных временных peer'ов.
  const tryConnectToKnownHost = async (
    hostId: string,
  ): Promise<HostDiscoveryResponsePayload | null> => {
    return new Promise(async (resolve) => {
      try {
        console.log('Trying to connect to known host (with reachability validation):', hostId)
        const mainPeer = peerService.getPeer()

        const doTempCheck = async () => {
          const tempPeer = new (await import('peerjs')).default()
          tempPeer.on('open', (tempId) => {
            const conn = tempPeer.connect(hostId)
            const timeout = setTimeout(() => {
              try {
                conn.close()
              } catch {}
              try {
                tempPeer.destroy()
              } catch {}
              resolve(null)
            }, 2000)
            conn.on('open', () => {
              conn.send({
                type: 'host_discovery_request',
                payload: {
                  requesterId: tempId,
                  requesterToken: myPlayer.value?.authToken || '',
                  timestamp: Date.now(),
                },
              })
            })
            conn.on('data', (data: any) => {
              const message = data as PeerMessage
              if (message.type === 'host_discovery_response') {
                const response = message.payload as HostDiscoveryResponsePayload
                clearTimeout(timeout)
                try {
                  conn.close()
                } catch {}
                try {
                  tempPeer.destroy()
                } catch {}
                if (response.isHost) {
                  resolve(response)
                } else {
                  resolve(null)
                }
              }
            })
            conn.on('error', () => {
              clearTimeout(timeout)
              try {
                tempPeer.destroy()
              } catch {}
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
          try {
            conn.close()
          } catch {}
          resolve(null)
        }, 2000)

        conn.on('open', () => {
          conn.send({
            type: 'host_discovery_request',
            payload: {
              requesterId: mainPeer.id,
              requesterToken: myPlayer.value?.authToken || '',
              timestamp: Date.now(),
            },
          })
        })

        conn.on('data', (data: any) => {
          const message = data as PeerMessage
          if (message.type === 'host_discovery_response') {
            const response = message.payload as HostDiscoveryResponsePayload
            clearTimeout(timeout)
            try {
              conn.close()
            } catch {}
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
    peerService.onMessage('host_discovery_request', (message: PeerMessage, conn: any) => {
      if (!conn) return

      const request = (message as Extract<PeerMessage, { type: 'host_discovery_request' }>).payload
      console.log('Received host discovery request:', request)

      const response: HostDiscoveryResponsePayload = {
        responderId: myPlayerId.value,
        responderToken: myPlayer.value?.authToken || '',
        isHost: isHost.value,
        currentHostId: gameState.value.hostId,
        gameState: gameState.value,
        timestamp: Date.now(),
      }

      // Отправляем ответ c корректным сообщением протокола
      conn.send(
        makeMessage('host_discovery_response', response, {
          roomId: gameState.value.roomId,
          fromId: myPlayerId.value,
          ts: Date.now(),
        }),
      )

      console.log('Sent host discovery response:', response)
    })
  }

  // Настройка mesh-протокола для P2P соединений между всеми игроками
  const setupMeshProtocolHandlers = () => {
    // Mesh protocol completely removed - using simple hub-and-spoke architecture
    // No peer-to-peer mesh networking, no host migration
  }

  // Вспомогательная функция для идемпотентной отправки с ретраями (экспоненциальная задержка)
  const gotFreshState = ref(false)

  async function sendWithRetry(
    targetId: string,
    buildMessage: () => PeerMessage,
    maxAttempts = 3,
    baseDelayMs = 300,
    stopOnStateUpdate = true,
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
      await new Promise((r) => setTimeout(r, delay))
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
      const existingWithNew = gameState.value.players.find((p) => p.id === newPeerId)
      if (!existingWithNew && oldHostId && oldHostId !== newPeerId) {
        const idx = gameState.value.players.findIndex((p) => p.id === oldHostId)
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
            authToken: generateAuthToken(
              newPeerId,
              roomId.value || gameState.value.roomId,
              Date.now(),
            ),
            votingCards: [...DEFAULT_CARDS.voting],
            bettingCards: [...DEFAULT_CARDS.betting],
          } as any)
        }

        // Ремап ссылок в состоянии на хоста
        if (gameState.value.litUpPlayerId === oldHostId) gameState.value.litUpPlayerId = newPeerId
        if (gameState.value.currentTurnPlayerId === oldHostId)
          gameState.value.currentTurnPlayerId = newPeerId

        if (gameState.value.votes) {
          const newVotes: Record<string, string[]> = {}
          Object.entries(gameState.value.votes).forEach(([k, v]) => {
            const mappedKey = k === oldHostId ? newPeerId : k
            const mappedArray = (v || []).map((t) => (t === oldHostId ? newPeerId : t))
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
        if (
          Array.isArray(gameState.value.roundWinners) &&
          gameState.value.roundWinners.length > 0
        ) {
          gameState.value.roundWinners = gameState.value.roundWinners.map((pid) =>
            pid === oldHostId ? newPeerId : pid,
          )
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
    peerService.setRoomContext(roomId.value || gameState.value.roomId || (null as any))
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)

    // 3.1) Восстанавливаем handlers и mesh, чтобы клиенты могли быстро нас обнаружить
    setupHostMessageHandlers()

    // 4) Немедленно шлем консистентный снапшот и объявление восстановления,
    // чтобы клиенты заякорились, а претенденты на миграцию отменили takeover
    broadcastGameState()
    try {
      peerService.broadcastMessage(
        makeMessage(
          'host_recovery_announcement',
          {
            recoveredHostId: newPeerId,
            gameState: { ...gameState.value },
          } as HostRecoveryAnnouncementPayload,
          { roomId: roomId.value || gameState.value.roomId, fromId: newPeerId, ts: Date.now() },
        ),
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
        HOST_SNAPSHOT_TTL,
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
      peerService.setRoomContext(roomId.value || gameState.value.roomId || (null as any))

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
      peerService.setCurrentHostId(targetHostId)
      peerService.setAsClient()

      // Настраиваем обработчики
      setupClientMessageHandlers()

      // КРИТИЧНО: Добавляем mesh-обработчики при восстановлении
  
      // Прочистим неактивные соединения
      try {
        peerService.cleanupInactiveConnections()
      } catch {}

      // Ждем немного для установки соединения
      await new Promise((resolve) => setTimeout(resolve, 300))

      // Идемпотентная отправка join_request с ретраями до получения свежего состояния
      await sendWithRetry(
        targetHostId,
        () =>
          makeMessage(
            'join_request',
            {
              nickname: myNickname.value,
              savedPlayerId: originalPlayerId, // Используем устойчивый/старый ID для поиска существующего игрока
            },
            {
              roomId: roomId.value || gameState.value.roomId,
              fromId: myPlayerId.value,
              ts: Date.now(),
            },
          ),
        3,
        300,
        true,
      )

      // Идемпотентный запрос актуального состояния с ретраями
      await sendWithRetry(
        targetHostId,
        () =>
          makeMessage(
            'request_game_state',
            { requesterId: myPlayerId.value },
            {
              roomId: roomId.value || gameState.value.roomId,
              fromId: myPlayerId.value,
              ts: Date.now(),
            },
          ),
        3,
        300,
        true,
      )

      // Note: peer list request removed - no longer needed in hub-and-spoke architecture

      // Ждем получения обновленного состояния (быстрая проверка)
      await waitForGameStateUpdate()

      // Дополнительная защита: если после sync hostId в состоянии отличается от targetHostId — обновим локально
      if (gameState.value.hostId && hostId.value !== gameState.value.hostId) {
        console.log('Adjusting hostId after state sync:', {
          prev: hostId.value,
          next: gameState.value.hostId,
        })
        hostId.value = gameState.value.hostId
      }

      // Note: peer list request in setTimeout removed - no longer needed in hub-and-spoke architecture

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
        const litUpPlayerValid =
          !gameState.value.litUpPlayerId ||
          gameState.value.players.some((p: Player) => p.id === gameState.value.litUpPlayerId)

        // Если в снапшоте была не 'lobby' — ждём не-lobby
        const phaseConsistent =
          snapshotPhase && snapshotPhase !== 'lobby'
            ? gameState.value.phase && gameState.value.phase !== 'lobby'
            : true

        if ((hasAnyPlayers && litUpPlayerValid && phaseConsistent) || attempts >= maxAttempts) {
          if (gameState.value.litUpPlayerId && !litUpPlayerValid) {
            console.log('Clearing invalid litUpPlayerId:', gameState.value.litUpPlayerId)
            gameState.value.litUpPlayerId = null
          }

          if ((gameState.value.phase ?? 'lobby') !== 'lobby') {
            gameState.value.gameStarted = true
          }

          console.log(
            'Game state synchronized (fast), players:',
            gameState.value.players.length,
            'phase:',
            gameState.value.phase,
            'litUpPlayerId:',
            gameState.value.litUpPlayerId,
            'hostId:',
            gameState.value.hostId,
            'roomId:',
            gameState.value.roomId,
          )
          resolve()
        } else {
          if (attempts === Math.floor(maxAttempts / 2)) {
            console.log('⏳ Waiting for state sync...', {
              attempts,
              players: gameState.value.players.length,
              phase: gameState.value.phase,
              hostId: gameState.value.hostId,
              roomId: gameState.value.roomId,
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
      // КРИТИЧНО: Устанавливаем флаг добровольного выхода ПЕРЕД любыми операциями
      isVoluntaryLeaving = true
      console.log('🚪 VOLUNTARY LEAVE: Set voluntary leaving flag to prevent reconnection')
      
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
          reason: 'explicit_leave',
        }
      }

      // 2) Формируем и отправляем событие user_left_room (одна попытка, без ретраев)
      const payload = {
        userId: me,
        roomId: roomId.value || gameState.value.roomId,
        timestamp: nowTs,
        currentScore: gameState.value.scores?.[me] ?? 0,
        reason: 'explicit_leave' as const,
      }

      try {
        peerService.sendMessage(
          hostId.value || gameState.value.hostId,
          makeMessage('user_left_room', payload as any, {
            roomId: payload.roomId,
            fromId: me,
            ts: Date.now(),
          }),
        )
      } catch {
        // Игнорируем: это best-effort уведомление, хост может обработать по таймауту присутствия
      }

      // 3) Отключаемся и чистим локальные данные, но не сбрасываем визуально историю очков
      // КРИТИЧНО: Очищаем все persistence данные перед отключением чтобы избежать автовосстановления
      try {
        storageSafe.nsRemove('game', 'hostGameStateSnapshot')
        storageSafe.nsRemove('global', 'piniaState')
        console.log('🗑️ Client cleared persistent state to prevent reconnection attempts')
      } catch {}
      
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
        alert('Не удалось покинуть комнату. Повторите попытку.')
      } catch {}
      
      // КРИТИЧНО: Сбрасываем флаг при ошибке тоже
      isVoluntaryLeaving = false
      console.log('🔄 VOLUNTARY LEAVE: Reset voluntary leaving flag due to error')
      
      throw e
    }
  }

  // Покинуть комнату
  const leaveRoom = async () => {
    // КРИТИЧНО: Устанавливаем флаг добровольного выхода для хоста тоже
    isVoluntaryLeaving = true
    console.log('🚪 VOLUNTARY LEAVE: Set voluntary leaving flag to prevent reconnection')
    
    console.log('🚪 LEAVE ROOM: Function called')
    console.log('🚪 LEAVE ROOM: Host is leaving the room', {
      roomId: roomId.value,
      isHost: isHost.value,
      myPlayerId: myPlayerId.value,
      currentPlayers: gameState.value.players.length
    })
    
    // КРИТИЧНО: Если это хост, уведомляем всех клиентов об уходе
    if (isHost.value && gameState.value.players.length > 1) {
      console.log('📢 LEAVE ROOM: Host notifying all clients about departure')
      try {
        const leaveMessage = makeMessage(
          'host_left_room',
          { hostId: myPlayerId.value, reason: 'voluntary_leave' },
          {
            roomId: roomId.value,
            fromId: myPlayerId.value,
            ts: Date.now(),
          }
        )
        // Отправляем всем клиентам
        gameState.value.players
          .filter(p => !p.isHost)
          .forEach(client => {
            try {
              peerService.sendMessage(client.id, leaveMessage)
              console.log(`📢 Notified client ${client.id} (${client.nickname}) about host departure`)
            } catch (err) {
              console.log(`❌ Failed to notify client ${client.id}:`, err)
            }
          })
      } catch (err) {
        console.log('❌ Error sending host departure notification:', err)
      }

      // Даем время для доставки сообщений перед отключением
      console.log('⏳ Waiting for departure messages to be delivered...')
      await new Promise(resolve => setTimeout(resolve, 300))
      console.log('⏳ Message delivery wait completed')
    }
    
    // КРИТИЧНО: Очищаем сохраненный peer ID хоста при покидании комнаты
    if (roomId.value && isHost.value) {
      console.log('🗑️ Clearing saved host peer ID for room:', roomId.value)
      peerService.clearSavedHostId(roomId.value)
      // Не трогаем ROOM_ID_STORAGE_KEY здесь, чтобы при случайной перезагрузке вкладки хоста roomId сохранялся
    }

    // Отключаемся от сети и чистим сессию/хранилище
    console.log('🔌 LEAVE ROOM: Calling peerService.disconnect()')
    peerService.disconnect()
    console.log('🧹 LEAVE ROOM: Calling clearSession()')
    clearSession()
    // Чистим все game-префикс ключи, никнейм сохраняется отдельно (без префикса)
    console.log('🗑️ LEAVE ROOM: Calling removeGameItemsByPrefix()')
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
      try {
        setNickname(myNickname.value || generateDefaultNickname())
      } catch {}
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

    // Migration state reset removed
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
      maxPlayers: GAME_CONFIG.MAX_PLAYERS,
      hostId: '',
      createdAt: 0,
      votingCards: {},
      bettingCards: {},
      currentTurn: 0,
      scores: {},
      // Для режима 2.0 (advanced)
      answers: {},
      guesses: {},
      currentQuestion: null,
      votes: {},
      bets: {},
    }

    // 6) Сброс любых runtime-хранилищ снапшотов
    try {
      storageSafe.nsRemove('game', 'hostGameStateSnapshot')
    } catch {}
    
    // КРИТИЧНО: Очищаем глобальное состояние Pinia чтобы избежать автовосстановления сессии
    try {
      storageSafe.nsRemove('global', 'piniaState')
      console.log('🗑️ Cleared global Pinia state to prevent automatic session restoration')
    } catch {}
    
    // 7) Сброс устойчивого playerId
    try {
      clearStablePlayerId()
    } catch {}

    console.log('✅ Pinia state fully reset to defaults after leaving room')
    
    // КРИТИЧНО: Сбрасываем флаг добровольного выхода в конце
    isVoluntaryLeaving = false
    console.log('🔄 VOLUNTARY LEAVE: Reset voluntary leaving flag')
    
    console.log('🏁 LEAVE ROOM: Function completed successfully')
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

  // ===== DEBUG: Снимок состояния и журнал действий =====
  /**
   * Выводит в консоль компактный снимок состояния текущего игрока и игры.
   * Показывает: мой ник/ID/роль (хост/клиент), текущий режим/фазу, комнату, хоста,
   * номер раунда и счетчик голосов/ставок. Удобно для диагностики зависаний.
   */
  function debugSnapshot(reason: string) {
    if (!isDebug.value) return
    try {
      const me = myPlayer.value
      const activePlayers = (gameState.value.players || []).filter(
        (p) => gameState.value.presence?.[p.id] !== 'absent',
      )
      const snapshot = {
        reason,
        now: new Date().toISOString(),
        roomId: roomId.value || gameState.value.roomId,
        hostId: hostId.value || gameState.value.hostId,
        isHost: isHost.value,
        my: {
          id: myPlayerId.value,
          nickname: me?.nickname,
          color: me?.color,
        },
        game: {
          mode: gameState.value.gameMode ?? gameMode.value,
          phase: gameState.value.phase ?? gamePhase.value,
          round: currentRound.value,
          playersTotal: gameState.value.players.length,
          playersActive: activePlayers.length,
          currentTurn: gameState.value.currentTurn,
          currentTurnPlayerId: gameState.value.currentTurnPlayerId,
          currentQuestion: gameState.value.currentQuestion,
        },
        votes: {
          votedCount: Object.keys(gameState.value.votes || {}).length,
          voteCounts: gameState.value.voteCounts || {},
        },
        bets: {
          betsCount: Object.keys(gameState.value.bets || {}).length,
        },
        scores: gameState.value.scores || {},
      }
      // Группируем лог для удобства чтения

      console.groupCollapsed('🧾 Снимок состояния')

      console.log(JSON.stringify(snapshot, null, 2))

      console.groupEnd()
    } catch {}
  }

  // Простой журнал действий для ключевых переходов/событий
  function logAction(event: string, payload?: Record<string, unknown>) {
    if (!isDebug.value) return
    try {
      const entry = {
        t: new Date().toISOString(),
        event,
        me: { id: myPlayerId.value, isHost: isHost.value },
        phase: gameState.value.phase ?? gamePhase.value,
        mode: gameState.value.gameMode ?? gameMode.value,
        round: currentRound.value,
        ...(payload || {}),
      }

      console.log('🪵 [Action]', entry)
    } catch {}
  }

  // Автоматический снимок состояния при ключевых изменениях — помогает ловить «залипы на 3-м раунде»
  watch(
    () => [
      gameState.value.phase,
      gameState.value.gameMode,
      currentRound.value,
      Object.keys(gameState.value.votes || {}).length,
      Object.keys(gameState.value.bets || {}).length,
    ],
    ([phase, mode, round, votedCount, betsCount]) => {
      debugSnapshot(
        `watch:phase=${phase};mode=${mode};round=${round};voted=${votedCount};bets=${betsCount}`,
      )
    },
    { deep: false },
  )

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
    { deep: true },
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
          {
            roomId: roomId.value || gameState.value.roomId,
            fromId: myPlayerId.value,
            ts: Date.now(),
          },
        ),
      )
    }
  }

  // --- Пул отправленных событий и блокировка кнопки ---
  const pendingEvents = ref<{ type: string; payload: any; attempts: number }[]>([])
  const isVoteSubmitting = ref(false)
  const isAnswerSubmitting = ref(false) // <-- Добавлено
  const isGuessSubmitting = ref(false) // <-- Добавлено

  const clientSubmitVote = (votes: string[]) => {
    if (isHost.value) {
      submitVote(myPlayerId.value, votes)
    } else {
      if (isVoteSubmitting.value) return
      isVoteSubmitting.value = true
      const event = {
        type: 'submit_vote' as const,
        payload: { voterId: myPlayerId.value, targetIds: votes },
        attempts: 1,
      }
      pendingEvents.value.push(event)
      sendVoteEvent(event)
    }
  }

  // --- Подтверждение доставки для голосов ---
  const voteAckMap = ref<Record<string, boolean>>({})

  function sendVoteEvent(event: { type: 'submit_vote'; payload: any; attempts: number }) {
    const voteKey = JSON.stringify(event.payload)
    console.log('[VOTE] Отправка события голосования:', { voteKey, attempts: event.attempts })
    peerService.sendMessage(
      hostId.value,
      makeMessage(
        event.type,
        { ...event.payload, stateVersion: gameState.value.stateVersion },
        {
          roomId: roomId.value || gameState.value.roomId,
          fromId: myPlayerId.value,
          ts: Date.now(),
        },
      ),
    )
    // Таймаут на случай отсутствия ack
    setTimeout(() => {
      if (!voteAckMap.value[voteKey] && pendingEvents.value.includes(event) && event.attempts < 3) {
        event.attempts++
        console.log('[VOTE] Повторная отправка голосования:', { voteKey, attempts: event.attempts })
        sendVoteEvent(event)
      } else if (!voteAckMap.value[voteKey] && pendingEvents.value.includes(event)) {
        // Превышено число попыток — удаляем и разблокируем
        console.warn(
          '[VOTE] Превышено число попыток отправки голосования, удаляем из очереди:',
          voteKey,
        )
        pendingEvents.value.splice(pendingEvents.value.indexOf(event), 1)
        isVoteSubmitting.value = false
      }
    }, 3000)
  }

  // Обработчики ACK для ответов и догадок
  peerService.onMessage('answer_ack' as any, (message: any) => {
    console.log('[ACK] Получено подтверждение ответа:', message.payload);
    isAnswerSubmitting.value = false;
  });

  peerService.onMessage('guess_ack' as any, (message: any) => {
    console.log('[ACK] Получено подтверждение догадки:', message.payload);
    isGuessSubmitting.value = false;
  });

  // Обработчик vote_ack на клиенте
  peerService.onMessage('vote_ack' as any, (message: any) => {
    const payload = message.payload || {}
    const voteKey = JSON.stringify(payload)
    console.log('[VOTE_ACK] Получено подтверждение голосования:', voteKey)
    voteAckMap.value[voteKey] = true
    // Удаляем событие из очереди и разблокируем кнопку
    const idx = pendingEvents.value.findIndex((e) => JSON.stringify(e.payload) === voteKey)
    if (idx !== -1) {
      console.log('[VOTE_ACK] Удаляем событие из очереди и разблокируем кнопку:', voteKey)
      pendingEvents.value.splice(idx, 1)
      isVoteSubmitting.value = false
    } else {
      console.warn('[VOTE_ACK] Подтверждение получено, но событие не найдено в очереди:', voteKey)
    }
  })

  // --- Пул отправленных ставок и блокировка кнопки ---
  const pendingBets = ref<{ type: string; payload: any; attempts: number }[]>([])
  const isBetSubmitting = ref(false)

  const clientSubmitBet = (bet: '0' | '±' | '+') => {
    if (isHost.value) {
      submitBet(myPlayerId.value, bet)
    } else {
      if (isBetSubmitting.value) return
      isBetSubmitting.value = true
      const event = {
        type: 'submit_bet' as const,
        payload: { playerId: myPlayerId.value, bet },
        attempts: 1,
      }
      pendingBets.value.push(event)
      sendBetEvent(event)
    }
  }

  function sendBetEvent(event: { type: 'submit_bet'; payload: any; attempts: number }) {
    peerService.sendMessage(
      hostId.value,
      makeMessage(
        event.type,
        { ...event.payload, stateVersion: gameState.value.stateVersion },
        {
          roomId: roomId.value || gameState.value.roomId,
          fromId: myPlayerId.value,
          ts: Date.now(),
        },
      ),
    )
    // Таймаут на случай отсутствия ответа
    setTimeout(() => {
      if (pendingBets.value.includes(event) && event.attempts < 3) {
        event.attempts++
        sendBetEvent(event)
      } else if (pendingBets.value.includes(event)) {
        // Превышено число попыток — удаляем и разблокируем
        pendingBets.value.splice(pendingBets.value.indexOf(event), 1)
        isBetSubmitting.value = false
      }
    }, 3000)
  }

  const clientSubmitAnswer = (answer: string) => {
    if (isHost.value) {
      // Хост локально заполняет и двигает фазу
      if (
        gamePhase.value === 'answering' &&
        myPlayerId.value === gameState.value.answeringPlayerId
      ) {
        gameState.value.advancedAnswer = answer
        gamePhase.value = 'guessing'
        gameState.value.phase = 'guessing'
        broadcastGameState()
        logAction('advanced_answer_submitted_switch_to_guessing', {
          currentQuestion: gameState.value.currentQuestion,
        })
        debugSnapshot('after_answer_to_guessing')
      }
    } else {
      peerService.sendMessage(
        hostId.value,
        makeMessage(
          'submit_answer',
          { playerId: myPlayerId.value, answer },
          {
            roomId: roomId.value || gameState.value.roomId,
            fromId: myPlayerId.value,
            ts: Date.now(),
          },
        ),
      )
    }
  }

  // --- Пул отправленных догадок и блокировка кнопки ---
  const pendingGuesses = ref<{ type: string; payload: any; attempts: number }[]>([])

  const clientSubmitGuess = (guess: string) => {
    if (isGuessSubmitting.value) return; // <-- Добавлено
    if (isHost.value) {
      if (!gameState.value.guesses) gameState.value.guesses = {}
      gameState.value.guesses[myPlayerId.value] = guess
      broadcastGameState()
      logAction('advanced_guess_submitted', { guessFor: myPlayerId.value })
      debugSnapshot('after_guess_submit')
    } else {
      if (isGuessSubmitting.value) return
      isGuessSubmitting.value = true
      const event = {
        type: 'submit_guess' as const,
        payload: { playerId: myPlayerId.value, guess },
        attempts: 1,
      }
      pendingGuesses.value.push(event)
      sendGuessEvent(event)
    }
  }

  function sendGuessEvent(event: { type: 'submit_guess'; payload: any; attempts: number }) {
    peerService.sendMessage(
      hostId.value,
      makeMessage(
        event.type,
        { ...event.payload, stateVersion: gameState.value.stateVersion },
        {
          roomId: roomId.value || gameState.value.roomId,
          fromId: myPlayerId.value,
          ts: Date.now(),
        },
      ),
    )
    // Таймаут на случай отсутствия ответа
    setTimeout(() => {
      if (pendingGuesses.value.includes(event) && event.attempts < 3) {
        event.attempts++
        sendGuessEvent(event)
      } else if (pendingGuesses.value.includes(event)) {
        // Превышено число попыток — удаляем и разблокируем
        pendingGuesses.value.splice(pendingGuesses.value.indexOf(event), 1)
        isGuessSubmitting.value = false
      }
    }, 3000)
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
      (winnerIds || []).filter(
        (id) =>
          id &&
          id !== chooserId &&
          // есть догадка именно в этом раунде
          !!(
            gameState.value.guesses &&
            typeof gameState.value.guesses[id] === 'string' &&
            gameState.value.guesses[id].trim().length > 0
          ) &&
          // игрок существует
          gameState.value.players.some((p) => p.id === id),
      ),
    )
    const winners = Array.from(validSet)

    if (!gameState.value.roundScores) gameState.value.roundScores = {}
    gameState.value.roundWinners = winners

    // Начисляем по 1 баллу каждому выбранному (только тем, кто отправил догадку)
    winners.forEach((pid) => {
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
          {
            roomId: roomId.value || gameState.value.roomId,
            fromId: myPlayerId.value,
            ts: Date.now(),
          },
        ),
      )
    }
  }

  // Migration state references removed

  const clientNextRound = (force = false) => {
    // Делаем обработчик идемпотентным: допускаем нажатие "Следующий раунд" как в 'results', так и в 'advanced_results'
    const isResultsPhase = gamePhase.value === 'results' || gamePhase.value === 'advanced_results'

    if (isHost.value) {
      // Если мы хост и уже не в фазе результатов, но на клиенте кнопка была нажата повторно —
      // игнорируем без ошибок (идемпотентность).
      if (!isResultsPhase) return

      const totalPlayers = gameState.value.players.length

      if (!force) {
        if (gameMode.value === 'basic') {
          // В basic кнопка доступна только после подсчета очков (results),
          // множественные нажатия не должны ломать состояние.
          const allVoted = Object.keys(gameState.value.votes || {}).length >= totalPlayers
          const allBet = Object.keys(gameState.value.bets || {}).length >= totalPlayers
          const resultsReady = gamePhase.value === 'results'
          if (!(allVoted && allBet && resultsReady)) return
        } else {
          // advanced: допускаем, что клиент мог нажать из 'advanced_results'
          const votedCount = Object.keys(gameState.value.votes || {}).length
          const guessesCount = Object.keys(gameState.value.guesses || {}).filter(
            (pid) => pid !== gameState.value.answeringPlayerId,
          ).length
          const requiredGuesses = Math.max(0, totalPlayers - 1)
          const resultsReady = gamePhase.value === 'advanced_results'
          if (!(votedCount >= totalPlayers && guessesCount >= requiredGuesses && resultsReady))
            return
        }
      }

      // Принудительный/обычный переход к следующему раунду
      finishRoundHostOnly(force)
    } else {
      // Клиент отправляет запрос хосту.
      // Если хост уже перешел из фаз результатов дальше, повторные клики не вызовут побочных эффектов — хост проигнорирует.
      peerService.sendMessage(
        hostId.value,
        makeMessage('next_round_request', { playerId: myPlayerId.value, force } as any, {
          roomId: roomId.value || gameState.value.roomId,
          fromId: myPlayerId.value,
          ts: Date.now(),
        }),
      )
    }
  }

  // UI helper: признак процесса восстановления/переподключения
  const uiConnecting = computed<boolean>(() => {
    return connectionStatus.value === 'connecting' || restorationState.value !== 'idle'
  })

  // ===== ДЕТЕРМИНИРОВАННАЯ ЭЛЕКЦИЯ ХОСТА ПО МИНИМАЛЬНОМУ ID + HEALTH CHECK =====

  // Находит игрока с минимальным id (строковое сравнение, id === peerId)
  function getMinIdHostCandidate(players: Player[]): Player | null {
    if (!players || players.length === 0) return null
    const now = Date.now()
    // фильтруем «мертвые» id, которые недавно падали на connect
    const alive = players.filter((p) => {
      if (!p?.id) return false
      const until = deadHostBlacklist.get(p.id)
      return !(until && until > now)
    })
    const sorted = (alive.length ? alive : players).sort((a, b) =>
      (a.id || '').localeCompare(b.id || ''),
    )
    return sorted[0] || null
  }

  // Отправка клиентам уведомления о новом хосте
  function broadcastNewHostId(newHostId: string) {
    try {
      const msg = makeMessage(
        'new_host_id' as any,
        {
          roomId: roomId.value || gameState.value.roomId,
          newHostId,
        } as any,
        {
          roomId: roomId.value || gameState.value.roomId,
          fromId: myPlayerId.value,
          ts: Date.now(),
        },
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
        (gameState.value.players || []).map((p) => p.id).filter((pid) => pid && pid !== newHostId),
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
              } catch {}
        console.warn('Timeout waiting for client_host_update_ack, continuing...')
        resolve()
      }, timeoutMs)
    })
  }

  // Публикуем полный снимок состояния всем клиентам (новый хост)
  // NOTE: если подобная функция уже объявлена выше, оставляем одну реализацию. Здесь — основная валидная версия.
  function hostBroadcastFullSnapshot() {
    try {
      const payload: any = {
        meta: {
          roomId: roomId.value || gameState.value.roomId,
          version: currentVersion.value || 0,
          serverTime: Date.now(),
        },
        state: { ...gameState.value },
      }
      
      // Логируем содержимое снапшота для отладки
      console.log('📤 HOST broadcasting state_snapshot with players:', {
        hostId: payload.state.hostId,
        playersCount: payload.state.players?.length || 0,
        players: payload.state.players?.map((p: any) => ({ 
          id: p.id, 
          nickname: p.nickname, 
          isHost: p.isHost 
        })) || []
      })
      
      // Отправляем индивидуально всем известным коннектам
      peerService.getConnectedPeers().forEach((pid: string) => {
        try {
          peerService.hostSendSnapshot(pid, payload)
        } catch {}
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
    peerService.onMessage('new_host_id', (message: PeerMessage) => {
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
          makeMessage('client_host_update_ack' as any, { hostId: newHost, ok: true } as any, {
            roomId: roomId.value || gameState.value.roomId,
            fromId: myPlayerId.value,
            ts: Date.now(),
          }),
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

  // Emergency takeover logic removed - using simple approach

  // Инициализация клиентских обработчиков для new_host_id (только однажды при создании стора)
  try {
    setupClientNewHostHandlers()
  } catch {}

  // --- СЕТЕВЫЕ ОБРАБОТЧИКИ ИГРОВЫХ СООБЩЕНИЙ И РОЛЕВАЯ ИНИЦИАЛИЗАЦИЯ ---
  // УДАЛЕНО: дублирующие определения setupClientMessageHandlers/setupHostMessageHandlers (см. выше основные версии)
  // Ниже оставлены только хелперы смены роли и глобальный heartbeat маршрутизатор.

  // Безопасная проверка и автоподключение к текущему хосту перед отправкой
  async function ensureConnectionToHost(): Promise<boolean> {
    const target = hostId.value || gameState.value.hostId
    if (!target) return false
    try {
      // если уже есть открытое соединение — ок
      if ((peerService as any).hasConnection && (peerService as any).hasConnection(target)) {
        return true
      }
      // если есть базовый peer — пробуем подключиться напрямую
      if ((peerService as any).getPeer && (peerService as any).getPeer()) {
        const ok = await (peerService as any).connectToPeer(target)
        return !!ok
      }
      // как fallback — путь клиента на хост
      if ((peerService as any).connectToHost) {
        await (peerService as any).connectToHost(target)
        return true
      }
    } catch (e) {
      console.warn('ensureConnectionToHost failed:', e)
    }
    return false
  }

  // Базовые синхронизационные сообщения (клиентская сторона)
  peerService.onMessage('game_state_update', (message: PeerMessage) => {
    const state = (message as any).payload as any
    console.log('📥 CLIENT received game_state_update:', {
      players: Array.isArray(state?.players) ? state.players.length : -1,
      hostId: state?.hostId,
      roomId: state?.roomId,
      phase: state?.phase,
    })
    // Обновляем базовое состояние
    try {
      gameState.value = { ...(gameState.value as any), ...(state || {}) }
      // Если хост сменился — фиксируем локально
      if (state?.hostId && hostId.value !== state.hostId) {
        hostId.value = state.hostId
        gameState.value.hostId = state.hostId
      }
      if (state?.roomId && !roomId.value) {
        roomId.value = state.roomId
      }
    } catch (e) {
      console.warn('Failed to apply game_state_update:', e)
    }
  })

  peerService.onMessage('state_snapshot', (message: PeerMessage) => {
    const payload = (message as any).payload as any
    const st = payload?.state
    console.log('📥 CLIENT received state_snapshot:', {
      meta: payload?.meta,
      hasRoom: !!st?.roomId,
      currentRoom: roomId.value,
      incomingRoom: st?.roomId,
      playersInPayload: Array.isArray(st?.players) ? st.players.length : -1,
    })
    if (st) {
      try {
        gameState.value = { ...(gameState.value as any), ...st }
        if (st.hostId) {
          hostId.value = st.hostId
        }
        if (st.roomId) {
          roomId.value = st.roomId
        }
        // Если снапшот включает моего игрока — синхронизируем myPlayerId при необходимости
        if (myPlayerId.value && !st.players?.some((p: any) => p?.id === myPlayerId.value)) {
          // не затираем, хост пришлёт player_id_updated
        }
      } catch (e) {
        console.warn('Failed to apply snapshot:', e)
      }
    }
  })

  peerService.onMessage('player_id_updated', (message: PeerMessage) => {
    const payload = (message as any).payload as { oldId: string; newId: string }
    console.log('🔄 CLIENT: Received player_id_updated message:', {
      oldId: payload?.oldId,
      newId: payload?.newId,
    })
    if (payload?.oldId && payload?.newId) {
      if (myPlayerId.value && myPlayerId.value === payload.oldId) {
        console.log('✅ CLIENT: Updating myPlayerId from old ID to new ID:', payload)
        myPlayerId.value = payload.newId
        // сохранить устойчивый id для переподключения
        try {
          saveStablePlayerId(payload.newId)
        } catch {}
      } else {
        console.log('❌ CLIENT: Ignoring player_id_updated message - old ID does not match:', {
          currentId: myPlayerId.value,
          oldId: payload?.oldId,
        })
      }
    }
  })

  // Хэндлер смены хоста с уведомлением
  peerService.onMessage('new_host_id', (message: PeerMessage) => {
    const payload = (message as any).payload || {}
    const newHost = payload.newHostId as string
    const rid = payload.roomId as string
    console.log('📥 CLIENT received new_host_id:', newHost)
    if (newHost) {
      hostId.value = newHost
      gameState.value.hostId = newHost
    }
    if (rid && !roomId.value) {
      roomId.value = rid
    }
    // ACK уже реализован выше в файле — оставляем как есть
  })

  // Heartbeat маршрутизация
  peerService.onMessage('heartbeat', (message: PeerMessage) => {
    const payload = (message as any).payload || {}
    const fromId = payload?.hostId || (message as any).meta?.fromId
    if (fromId) {
      peerService.handleHeartbeat(fromId)
    }
  })
  // end of setupClientMessageHandlers (переехавшие обработчики)
  // ====== ХЕЛПЕРЫ DISCOVERY/RESTORE С ПРОВЕРКОЙ ДОСТУПНОСТИ ХОСТА ======
  async function isHostReachableOnce(hostPeerId: string, timeoutMs = 1500): Promise<boolean> {
    try {
      const basePeer = (peerService as any).getPeer?.()
      if (!basePeer || !basePeer.open) return false
      const result = await (peerService as any).connectToPeer?.(hostPeerId)
      if (result) return true
      return false
    } catch {
      return false
    } finally {
      // не оставляем мусорные соединения — cleanup выполнит peerService при последующих send
    }
  }

  function markDeadHost(hostPeerId: string) {
    deadHostBlacklist.set(hostPeerId, Date.now() + DEAD_HOST_TTL_MS)
  }

  async function tryRestoreAsClientWithHealthCheck(targetHostId: string): Promise<boolean> {
    const reachable = await isHostReachableOnce(targetHostId, 1500)
    if (!reachable) {
      console.log(
        'Health-check failed for host:',
        targetHostId,
        '— skipping restore and blacklisting briefly',
      )
      markDeadHost(targetHostId)
      return false
    }
    await restoreAsClient(targetHostId)
    return true
  }

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
    // Submission flags for UI
    isVoteSubmitting,
    isAnswerSubmitting,
    isGuessSubmitting,
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
    // lightUpPlayer экспортировался раньше — но он отсутствует в этом файле. Уберём из экспорта, чтобы не ломать типы.
    // Host-side direct actions (используются хостом)
    drawCard,
    submitVote,
    submitBet,
    finishRound: finishRoundHostOnly,
    leaveRoom,
    leaveGracefully: clientLeaveRoom,
    // broadcastGameState отсутствует как публичный API — не экспортируем

    // Client-side actions (обертки, отправка сообщений)
    drawQuestion: clientDrawQuestion,
    sendVote: clientSubmitVote,
    sendBet: clientSubmitBet,
    sendAnswer: clientSubmitAnswer,
    sendGuess: clientSubmitGuess,
    sendWinners: clientSubmitWinners,
    nextRound: clientNextRound,
    // Принудительное продвижение фазы хостом (skip)
    forceContinue: (phase?: string) => {
      // Публичный API с безопасным флагом allowForce = true
      finishRoundHostOnly(true)
    },

    // Advanced mode direct state helpers (временные, для совместимости)
    submitAnswer: (playerId: string, answer: string) => {
      if (!gameState.value.answers) gameState.value.answers = {}
      gameState.value.answers[playerId] = answer
    },
    submitGuess: (playerId: string, guess: string) => {
      if (!gameState.value.guesses) gameState.value.guesses = {}
      gameState.value.guesses[playerId] = guess
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
    lastErrorRestore,
  }
})
