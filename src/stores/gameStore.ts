import {ref, computed, watch} from 'vue'
import {defineStore} from 'pinia'
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
 * - SESSION_STORAGE_KEY: локальная сессия игрока
 * - HOST_STATE_STORAGE_KEY: снапшот состояния игры от хоста
 */
const SESSION_STORAGE_KEY = 'gameSessionData'
const HOST_STATE_STORAGE_KEY = 'hostGameStateSnapshot'
const ROOM_ID_STORAGE_KEY = 'persistentRoomId'
const SESSION_TIMEOUT = 30 * 60 * 1000 // 30 минут

interface SessionData extends ExtendedSessionData {
  // Наследуем все поля от ExtendedSessionData для совместимости
}

export const useGameStore = defineStore('game', () => {

  // Game mechanics for "Провокатор"
  // Структура голосов: { [voterId]: [targetId, targetId] }
  // Структура ставок: { [playerId]: '0' | '+-' | '+' }
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
      player.bettingCards = ['0', '+-', '+']
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
      } else if (bet === '+-' && votes > 0 && !leaders.includes(pid)) {
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

  // Игрок делает ставку: bet — '0' | '+-' | '+'
  const submitBet = (playerId: string, bet: '0' | '+-' | '+') => {
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
          player.bettingCards = ['0', '+-', '+']
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
  const myNickname = ref<string>('')
  const isHost = ref<boolean>(false)
  const hostId = ref<string>('')
  const roomId = ref<string>('')
  const connectionStatus = ref<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const restorationState = ref<'idle' | 'discovering' | 'restoring'>('idle')

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

  // Генерация случайного цвета
  const generateRandomColor = (): string => {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
      '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
    ]
    return colors[Math.floor(Math.random() * colors.length)]
  };

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

  // Устойчивое хранение roomId между перезагрузками хоста
  const savePersistentRoomId = (rid: string) => {
    try {
      localStorage.setItem(ROOM_ID_STORAGE_KEY, rid)
    } catch {}
  }
  const loadPersistentRoomId = (): string | null => {
    try {
      return localStorage.getItem(ROOM_ID_STORAGE_KEY)
    } catch {
      return null
    }
  }
  const clearPersistentRoomId = () => {
    try {
      localStorage.removeItem(ROOM_ID_STORAGE_KEY)
    } catch {}
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
    try {
      connectionStatus.value = 'connecting'

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
          color: generateRandomColor(),
          isHost: true,
          joinedAt: now,
          authToken: generateAuthToken(restoredPeerId, targetRoomId, now),
          votingCards: ['Голос 1', 'Голос 2'],
          bettingCards: ['0', '+-', '+']
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

      console.log('🏁 Host initialization completed with ID:', restoredPeerId)
      return restoredPeerId

    } catch (error) {
      connectionStatus.value = 'disconnected'
      throw error
    }
  }

  // Подключение к комнате (клиент)
  const joinRoom = async (nickname: string, targetHostId: string) => {
    try {
      connectionStatus.value = 'connecting'

      await peerService.connectToHost(targetHostId)

      myNickname.value = nickname
      hostId.value = targetHostId
      myPlayerId.value = peerService.getMyId() || ''

      // Устанавливаем роль клиента
      peerService.setAsClient()

      // Отправляем запрос на подключение
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'join_request',
          {
            nickname,
            savedPlayerId: myPlayerId.value // КРИТИЧНО: передаем ID для отслеживания переподключений
          },
          { roomId: roomId.value || '', fromId: myPlayerId.value, ts: Date.now() } as MessageMeta
        )
      )

      // КРИТИЧНО: Сразу запрашиваем список всех игроков для mesh-подключения
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'request_peer_list',
          {
            requesterId: myPlayerId.value,
            requesterToken: '',
            timestamp: Date.now()
          },
          { roomId: roomId.value || '', fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      connectionStatus.value = 'connected'
      setupClientMessageHandlers()
    } catch (error) {
      connectionStatus.value = 'disconnected'
      throw error
    }
  }

  // Настройка обработчиков сообщений для хоста
  const setupHostMessageHandlers = () => {
    console.log('Setting up host message handlers')

    // КРИТИЧНО: Очищаем старые обработчики перед настройкой новых
    peerService.clearMessageHandlers()
    console.log('Cleared old message handlers before setting up host handlers')

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
          const newBets: Record<string, '0' | '+-' | '+'> = {}
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
      const newPlayer: Player = {
        id: conn.peer,
        nickname,
        color: generateRandomColor(),
        isHost: false,
        joinedAt: now,
        authToken: generateAuthToken(conn.peer, gameState.value.roomId, now),
        votingCards: ['Карточка 1', 'Карточка 2'],
        bettingCards: ['0', '+-', '+']
      }

      console.log('Adding new player:', newPlayer)
      gameState.value.players.push(newPlayer)

      // Отправляем обновленное состояние всем игрокам
      broadcastGameState()
      console.log('Updated players list:', gameState.value.players.map((p: Player) => ({id: p.id, nickname: p.nickname})))
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

      console.log('Host sending game state to client:', conn.peer)

      // Перед отправкой убеждаемся, что phase/gameMode синхронизированы с локальными рефами
      gameState.value.phase = gamePhase.value
      gameState.value.gameMode = gameMode.value

      // Отправляем актуальное состояние игры запросившему клиенту
      peerService.sendMessage(
        conn.peer,
        makeMessage(
          'game_state_update',
          gameState.value,
          { roomId: gameState.value.roomId, fromId: gameState.value.hostId, ts: Date.now() }
        )
      )
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
      const bet = (payload as any).bet as ('0' | '+-' | '+') | undefined

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

    peerService.onMessage('game_state_update', (message) => {
      // Защита: принимаем только если мы клиент (у хоста истина в локальном состоянии)
      if (isHost.value) return

      const newState = { ...(message as Extract<PeerMessage, { type: 'game_state_update' }>).payload }

      // Немедленно кешируем снапшот состояния, полученный от хоста,
      // чтобы после перезагрузки не «проваливаться» в лобби.
      try {
        localStorage.setItem(HOST_STATE_STORAGE_KEY, JSON.stringify({
          ts: Date.now(),
          state: newState
        }))
      } catch (e) {
        console.warn('Failed to cache host snapshot on client', e)
      }

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

      gameState.value = newState
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
      handleHostDisconnection()
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

      // Пишем снапшот хоста в localStorage, чтобы клиенты могли «якориться» после перезагрузки
      try {
        localStorage.setItem(HOST_STATE_STORAGE_KEY, JSON.stringify({
          ts: Date.now(),
          state: snapshot
        }))
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
  }>({
    inProgress: false,
    phase: null,
    proposedHostId: null,
    votes: new Map(),
    timeout: null
  })

  // Простая система переподключения к отключившемуся хосту
  const handleHostDisconnection = async () => {
    console.log('🚨 Host disconnection detected, starting reconnection attempts...')
    console.log('🔍 DISCONNECTION STATE:', {
      currentHostId: gameState.value.hostId,
      myPlayerId: myPlayerId.value,
      connectionStatus: connectionStatus.value,
      gameStarted: gameState.value.gameStarted,
      playersCount: gameState.value.players.length
    })

    // Защита от повторных вызовов
    if (connectionStatus.value === 'connecting') {
      console.log('Already trying to reconnect, ignoring...')
      return
    }

    const originalHostId = gameState.value.hostId
    connectionStatus.value = 'connecting'

    // Простая логика: пытаемся переподключиться к тому же хосту
    await attemptReconnectionToHost(originalHostId)
  }

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

        // Отправляем запрос на подключение с сохраненным ID для повторного подключения
      peerService.sendMessage(
        hostId,
        makeMessage(
          'join_request',
          {
            nickname: myNickname.value,
            savedPlayerId: myPlayerId.value  // КРИТИЧНО: передаем текущий ID как сохраненный
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

    // Все попытки неудачны
    console.log('❌ All reconnection attempts failed. Host is likely permanently disconnected.')
    connectionStatus.value = 'disconnected'

    // Можно добавить логику для отображения сообщения пользователю
    // о том, что хост недоступен и нужно покинуть комнату
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
  const startSecureMigration = async (validPlayers: Player[]) => {
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
    // Сортируем по nickname для детерминированности (как в electHostDeterministic)
    const sortedPlayers = validPlayers.sort((a: Player, b: Player) => a.nickname.localeCompare(b.nickname))

    if (sortedPlayers.length === 0) {
      throw new Error('No valid players for host election')
    }

      console.log('🔍 HOST ELECTION ALGORITHM:', {
        validPlayers: (validPlayers as Player[]).map((p: Player) => ({id: p.id, nickname: p.nickname})),
        sortedPlayers: (sortedPlayers as Player[]).map((p: Player) => ({id: p.id, nickname: p.nickname})),
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

    // Запускаем heartbeat
    peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)
    // Запускаем heartbeat
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

      // Запрашиваем актуальное состояние игры
      peerService.sendMessage(
        newHostId,
        makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          { roomId: gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )
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
    // Сортируем игроков по никнейму для консистентности
    const sortedPlayers = validPlayers.sort((a: Player, b: Player) => a.nickname.localeCompare(b.nickname))

    if (sortedPlayers.length === 0) {
      throw new Error('No valid players for deterministic host election')
    }

    // Первый по никнейму становится хостом
    const deterministicHostId = sortedPlayers[0].id
    console.log('Deterministic host elected:', deterministicHostId, 'nickname:', sortedPlayers[0].nickname)

    return deterministicHostId
  }

  // Детерминированный алгоритм выборов нового хоста
  const electNewHost = (): string => {
    // Сортируем игроков по ID для детерминированности
    const remainingPlayers = gameState.value.players
      .filter((p: Player) => p.id !== (gameState.value.hostId || ''))
      .sort((a: Player, b: Player) => a.id.localeCompare(b.id))

    if (remainingPlayers.length === 0) {
      throw new Error('No remaining players for host election')
    }

    // Первый в отсортированном списке становится хостом
    const newHostId = remainingPlayers[0].id
    console.log('New host elected:', newHostId)

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
  const saveSession = () => {
    if (!myPlayerId.value || connectionStatus.value === 'disconnected') {
      return
    }

    const sessionData: SessionData = {
      gameState: gameState.value,
      myPlayerId: myPlayerId.value,
      myNickname: myNickname.value,
      isHost: isHost.value,
      hostId: hostId.value,
      roomId: roomId.value,
      timestamp: Date.now(),
      meshTopology: peerService.getAllKnownPeers(),
      lastHeartbeat: Date.now(),
      networkVersion: gameState.value.createdAt // Используем время создания игры как версию сети
    }

    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionData))
    console.log('Extended session saved:', sessionData)
  }

  // Загрузка сессии из localStorage
  const loadSession = (): SessionData | null => {
    try {
      const savedData = localStorage.getItem(SESSION_STORAGE_KEY)
      if (!savedData) return null

      const sessionData: SessionData = JSON.parse(savedData)

      // Проверяем, не истекла ли сессия
      const now = Date.now()
      if (now - sessionData.timestamp > SESSION_TIMEOUT) {
        console.log('Session expired, removing from storage')
        localStorage.removeItem(SESSION_STORAGE_KEY)
        return null
      }

      console.log('Session loaded:', sessionData)
      return sessionData
    } catch (error) {
      console.error('Failed to load session:', error)
      localStorage.removeItem(SESSION_STORAGE_KEY)
      return null
    }
  }

  // Удаление сессии
  const clearSession = () => {
    localStorage.removeItem(SESSION_STORAGE_KEY)
    console.log('Session cleared')
  }

  // Универсальное восстановление состояния из сохраненной сессии
  const restoreSession = async (): Promise<boolean> => {
    const sessionData = loadSession()
    if (!sessionData) return false

    try {
      console.log('Attempting to restore session...')
      restorationState.value = 'discovering'
      connectionStatus.value = 'connecting'

      // Берем максимально свежий «якорь»: снапшот от хоста (если есть), иначе из своей сессии
      let anchorState = sessionData.gameState
      try {
        const hostSnap = localStorage.getItem(HOST_STATE_STORAGE_KEY)
        if (hostSnap) {
          const parsed = JSON.parse(hostSnap) as { ts: number, state: GameState }
          // Если room совпадает и снапшот свежий — используем его
          if (parsed?.state?.roomId && parsed.state.roomId === sessionData.roomId) {
            anchorState = parsed.state as any
            console.log('Using cached host snapshot as anchor for restore')
          }
        }
      } catch (e) {
        console.warn('Failed to read host snapshot', e)
      }

      // Восстанавливаем локальное состояние из «якоря»
      gameState.value = { ...anchorState }
      // КРИТИЧНО: если фаза не 'lobby', считаем игру начатой
      if ((gameState.value.phase ?? 'lobby') !== 'lobby') {
        gameState.value.gameStarted = true
      }

      myPlayerId.value = sessionData.myPlayerId
      myNickname.value = sessionData.myNickname
      roomId.value = sessionData.roomId

      // УНИВЕРСАЛЬНАЯ ЛОГИКА: всегда начинаем с discovery
      console.log('Starting universal host discovery...')
      const currentHost = await universalHostDiscovery(sessionData)

      restorationState.value = 'restoring'

      if (currentHost) {
        console.log('Found active host, connecting as client:', currentHost.currentHostId)
        // Найден активный хост - подключаемся как клиент
        isHost.value = false
        hostId.value = currentHost.currentHostId
        await restoreAsClient(currentHost.currentHostId)
      } else {
        console.log('No active host found, becoming host...')
        // Никого нет - становимся хостом (первый восстановившийся)
        isHost.value = true
        await restoreAsHost()
      }

      restorationState.value = 'idle'
      connectionStatus.value = 'connected'
      console.log('Session successfully restored')
      return true
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to restore session:', error.message)
      } else {
        console.error('Failed to restore session: Unknown error')
      }
      restorationState.value = 'idle'
      connectionStatus.value = 'disconnected'
      clearSession()
      return false
    }
  }

  // Универсальный опрос для обнаружения текущего хоста (более агрессивная стратегия)
  const universalHostDiscovery = async (sessionData: SessionData): Promise<HostDiscoveryResponsePayload | null> => {
    console.log('Starting universal host discovery...')

    // Стратегия 1: Попытка подключения к последнему известному хосту
    if (sessionData.hostId && sessionData.hostId !== sessionData.myPlayerId) {
      console.log('Strategy 1: Trying to connect to last known host:', sessionData.hostId)
      const lastKnownHost = await tryConnectToKnownHost(sessionData.hostId)
      if (lastKnownHost) {
        console.log('Last known host is still active:', sessionData.hostId)
        return lastKnownHost
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
  const tryConnectToKnownHost = async (hostId: string): Promise<HostDiscoveryResponsePayload | null> => {
    return new Promise(async (resolve) => {
      try {
        console.log('Trying to connect to known host:', hostId)
        const tempPeer = new (await import('peerjs')).default()

        tempPeer.on('open', (tempId) => {
          const conn = tempPeer.connect(hostId)

          const timeout = setTimeout(() => {
            conn.close()
            tempPeer.destroy()
            resolve(null)
          }, 2000) // Короткий таймаут для быстрой проверки

          conn.on('open', () => {
            console.log('Successfully connected to known host')

            // Отправляем discovery запрос
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
              console.log('Received response from known host:', response)

              clearTimeout(timeout)
              conn.close()
              tempPeer.destroy()

              if (response.isHost) {
                resolve(response)
              } else {
                resolve(null)
              }
            }
          })

          conn.on('error', () => {
            clearTimeout(timeout)
            tempPeer.destroy()
            resolve(null)
          })
        })

        tempPeer.on('error', () => {
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
    const newPeerId = await peerService.createHost(roomId.value)

    // Обновляем ID хоста в состоянии
    const oldHostId = myPlayerId.value
    myPlayerId.value = newPeerId
    hostId.value = newPeerId
    gameState.value.hostId = newPeerId

    // Обновляем свой ID в списке игроков
      const myPlayerIndex = gameState.value.players.findIndex((p: Player) => p.id === oldHostId)
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].id = newPeerId
    }

    // Устанавливаем роль хоста и запускаем heartbeat
    peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)
    // Устанавливаем роль хоста и запускаем heartbeat
    peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)
    // Устанавливаем роль хоста и запускаем heartbeat
    peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)
    // Устанавливаем роль хоста и запускаем heartbeat
    peerService.setRoomContext(roomId.value || gameState.value.roomId || null as any)
    peerService.setAsHost(newPeerId, roomId.value || gameState.value.roomId)

    // Настраиваем обработчики
    setupHostMessageHandlers()
    // Немедленно шлем консистентный снапшот, чтобы клиенты выровнялись после рестарта хоста
    broadcastGameState()

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

      // ИСПРАВЛЕНО: НЕ очищаем litUpPlayerId сразу, дождемся актуального состояния
      console.log('Keeping current litUpPlayerId until state sync:', gameState.value.litUpPlayerId)

      // Сохраняем старый ID ПЕРЕД его перезаписью
      const originalPlayerId = myPlayerId.value
      console.log('Saved original player ID for reconnection:', originalPlayerId)

      // Пытаемся переподключиться к хосту
      await peerService.connectToHost(targetHostId)

      // Обновляем свой ID на новый PeerJS ID
      myPlayerId.value = peerService.getMyId() || ''
      console.log('Updated to new peer ID:', myPlayerId.value)

      // Устанавливаем роль клиента
      peerService.setAsClient()

      // Настраиваем обработчики
      setupClientMessageHandlers()

      // КРИТИЧНО: Добавляем mesh-обработчики при восстановлении
      setupMeshProtocolHandlers()

      // Ждем немного для установки соединения
      await new Promise(resolve => setTimeout(resolve, 500))

      // Отправляем запрос с правильным старым ID для поиска существующего игрока
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'join_request',
          {
            nickname: myNickname.value,
            savedPlayerId: originalPlayerId // Используем СТАРЫЙ ID для поиска существующего игрока
          },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      // Ждем немного для обработки подключения
      await new Promise(resolve => setTimeout(resolve, 300))

      // Запрашиваем актуальное состояние игры
      peerService.sendMessage(
        targetHostId,
        makeMessage(
          'request_game_state',
          { requesterId: myPlayerId.value },
          { roomId: roomId.value || gameState.value.roomId, fromId: myPlayerId.value, ts: Date.now() }
        )
      )

      // КРИТИЧНО: Запрашиваем список peer'ов для mesh-соединений
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

      // Ждем получения обновленного состояния
      await waitForGameStateUpdate()

      console.log('Client restored and reconnected with updated state')
    } catch (error: unknown) {
      console.error('Failed to restore as client:', error)
      // Если не удалось подключиться к старому хосту, пытаемся найти нового
      await handleHostDisconnection()
    }
  }

  // Ожидание обновления состояния игры
  const waitForGameStateUpdate = (): Promise<void> => {
    return new Promise((resolve) => {
      let attempts = 0
      const maxAttempts = 20

      const snapshotPhase = gameState.value.phase

      const checkForUpdate = () => {
        attempts++

        // Проверяем, что у нас есть актуальные данные игроков
        const hasValidPlayers = gameState.value.players.length > 0 &&
          gameState.value.players.some((p: Player) => p.nickname && p.nickname !== '')

        // Проверяем корректность litUpPlayerId - если указан, то игрок должен существовать
        const litUpPlayerValid = !gameState.value.litUpPlayerId ||
          gameState.value.players.some((p: Player) => p.id === gameState.value.litUpPlayerId)

        // Если в снапшоте была не 'lobby' — ждём прихода валидной (не 'lobby') фазы
        const phaseConsistent = snapshotPhase && snapshotPhase !== 'lobby'
          ? (gameState.value.phase && gameState.value.phase !== 'lobby')
          : true

        if ((hasValidPlayers && litUpPlayerValid && phaseConsistent) || attempts >= maxAttempts) {
          // Очищаем некорректный litUpPlayerId если игрок не найден
          if (gameState.value.litUpPlayerId && !litUpPlayerValid) {
            console.log('Clearing invalid litUpPlayerId:', gameState.value.litUpPlayerId)
            gameState.value.litUpPlayerId = null
          }

          // Если пришла валидная фаза — синхронизируем флаг gameStarted
          if ((gameState.value.phase ?? 'lobby') !== 'lobby') {
            gameState.value.gameStarted = true
          }

          console.log('Game state synchronized, players:', gameState.value.players.length,
            'phase:', gameState.value.phase,
            'litUpPlayerId:', gameState.value.litUpPlayerId)
          resolve()
        } else {
          // Пробуем еще раз через короткий интервал
          setTimeout(checkForUpdate, 200)
        }
      }

      // Начальная проверка через небольшую задержку
      setTimeout(checkForUpdate, 300)
    })
  }

  // Проверка наличия активной сессии
  const hasActiveSession = (): boolean => {
    const sessionData = loadSession()
    return sessionData !== null
  }

  // Покинуть комнату
  const leaveRoom = () => {
    // КРИТИЧНО: Очищаем сохраненный peer ID хоста при покидании комнаты
    if (roomId.value && isHost.value) {
      console.log('🗑️ Clearing saved host peer ID for room:', roomId.value)
      peerService.clearSavedHostId(roomId.value)
      // Не трогаем ROOM_ID_STORAGE_KEY здесь, чтобы при случайной перезагрузке вкладки хоста roomId сохранялся
    }

    peerService.disconnect()
    clearSession()

    // Сброс состояния
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

    myPlayerId.value = ''
    if (!myNickname.value.startsWith(NICKNAME_PREFIX)) {
      localStorage.setItem('savedNickname', myNickname.value || generateDefaultNickname())
    }
    myNickname.value = ''
    isHost.value = false
    hostId.value = ''
    roomId.value = ''
    connectionStatus.value = 'disconnected'
  }

  // Установка никнейма по умолчанию при инициализации
  if (!myNickname.value) {
    myNickname.value = generateDefaultNickname()
  }

  // При инициализации, если мы будем создавать комнату — переиспользуем стабильный roomId
  const preloadedRoomId = loadPersistentRoomId()
  if (preloadedRoomId && !roomId.value) {
    roomId.value = preloadedRoomId
  }

  // Автоматическое сохранение сессии при изменениях
  watch(
    [gameState, myPlayerId, myNickname, isHost, hostId, roomId, connectionStatus],
    () => {
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

  const clientSubmitBet = (bet: '0' | '+-' | '+') => {
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

  return {
    // State
    gameState,
    myPlayerId,
    myNickname,
    isHost,
    hostId,
    roomId,
    connectionStatus,
    gameMode,
    gamePhase,

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
    generateDefaultNickname
  }
})
