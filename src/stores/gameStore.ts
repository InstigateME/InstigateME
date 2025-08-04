import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Player, GameState, PeerMessage, MigrationProposalPayload, MigrationVotePayload, MigrationConfirmedPayload, NewHostIdPayload } from '@/types/game'
import { peerService } from '@/services/peerService'
import { MIGRATION_TIMEOUT, VOTE_TIMEOUT } from '@/types/game'

// Ключи для localStorage
const SESSION_STORAGE_KEY = 'gameSessionData'
const SESSION_TIMEOUT = 30 * 60 * 1000 // 30 минут

interface SessionData {
  gameState: GameState
  myPlayerId: string
  myNickname: string
  isHost: boolean
  hostId: string
  roomId: string
  timestamp: number
}

export const useGameStore = defineStore('game', () => {
  // Состояние игры
  const gameState = ref<GameState>({
    roomId: '',
    gameStarted: false,
    players: [],
    litUpPlayerId: null,
    maxPlayers: 8,
    hostId: '',
    createdAt: 0
  })

  // Локальные данные
  const myPlayerId = ref<string>('')
  const myNickname = ref<string>('')
  const isHost = ref<boolean>(false)
  const hostId = ref<string>('')
  const roomId = ref<string>('')
  const connectionStatus = ref<'disconnected' | 'connecting' | 'connected'>('disconnected')

  // Computed
  const canStartGame = computed(() => 
    isHost.value && gameState.value.players.length >= 2 && !gameState.value.gameStarted
  )

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
  }

  // Генерация никнейма по умолчанию
  const generateDefaultNickname = (): string => {
    return `Player${Math.floor(Math.random() * 9999)}`
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
      const peerId = await peerService.createHost()
      const now = Date.now()
      const newRoomId = generateRoomId()
      
      myPlayerId.value = peerId
      myNickname.value = nickname
      isHost.value = true
      roomId.value = newRoomId
      hostId.value = peerId
      
      // Инициализация состояния игры
      gameState.value = {
        roomId: newRoomId,
        gameStarted: false,
        players: [],
        litUpPlayerId: null,
        maxPlayers: 8,
        hostId: peerId,
        createdAt: now
      }
      
      // Добавляем хоста в список игроков
      const hostPlayer: Player = {
        id: peerId,
        nickname,
        color: generateRandomColor(),
        isHost: true,
        joinedAt: now,
        authToken: generateAuthToken(peerId, newRoomId, now)
      }
      
      gameState.value.players = [hostPlayer]
      connectionStatus.value = 'connected'
      
      // Устанавливаем роль хоста и запускаем heartbeat
      peerService.setAsHost(peerId)
      
      setupHostMessageHandlers()
      return peerId
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
      peerService.sendMessage(targetHostId, {
        type: 'join_request',
        payload: { nickname }
      })
      
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
      
      const { nickname } = message.payload
      
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
      const { savedPlayerId } = message.payload
      if (savedPlayerId) {
        const existingPlayerBySavedId = gameState.value.players.find(p => p.id === savedPlayerId && !p.isHost)
        if (existingPlayerBySavedId) {
          console.log('Found existing player by saved ID, updating connection:', {
            savedId: savedPlayerId,
            newConnectionId: conn.peer,
            nickname: nickname
          })
          
          // Обновляем ID соединения существующего игрока
          existingPlayerBySavedId.id = conn.peer
          existingPlayerBySavedId.authToken = generateAuthToken(conn.peer, gameState.value.roomId, Date.now())
          
          broadcastGameState()
          console.log('Updated existing player:', existingPlayerBySavedId)
          return
        }
      }
      
      // Создаем нового игрока только если такого никнейма нет
      const now = Date.now()
      const newPlayer: Player = {
        id: conn.peer,
        nickname,
        color: generateRandomColor(),
        isHost: false,
        joinedAt: now,
        authToken: generateAuthToken(conn.peer, gameState.value.roomId, now)
      }
      
      console.log('Adding new player:', newPlayer)
      gameState.value.players.push(newPlayer)
      
      // Отправляем обновленное состояние всем игрокам
      broadcastGameState()
      console.log('Updated players list:', gameState.value.players.map(p => ({ id: p.id, nickname: p.nickname })))
    })

    peerService.onMessage('light_up_request', (message) => {
      console.log('Host received light_up_request:', message.payload)
      const { playerId } = message.payload
      
      if (gameState.value.gameStarted) {
        console.log('Processing light up for player:', playerId)
        gameState.value.litUpPlayerId = playerId
        broadcastGameState()
        
        // Убираем подсветку через 2 секунды
        setTimeout(() => {
          gameState.value.litUpPlayerId = null
          broadcastGameState()
        }, 2000)
      } else {
        console.log('Game not started, ignoring light_up_request')
      }
    })
    
    peerService.onMessage('request_game_state', (message, conn) => {
      if (!conn) return
      
      console.log('Host sending game state to client:', conn.peer)
      // Отправляем актуальное состояние игры запросившему клиенту
      peerService.sendMessage(conn.peer, {
        type: 'game_state_update',
        payload: gameState.value
      })
    })
  }

  // Настройка обработчиков сообщений для клиента
  const setupClientMessageHandlers = () => {
    peerService.onMessage('game_state_update', (message) => {
      gameState.value = { ...message.payload }
    })
    
    peerService.onMessage('heartbeat', (message) => {
      const { hostId: heartbeatHostId } = message.payload
      peerService.handleHeartbeat(heartbeatHostId)
    })
    
    // Настройка callback для обнаружения отключения хоста
    peerService.onHostDisconnected(() => {
      handleHostDisconnection()
    })
    
    // Добавляем обработчики миграции
    setupMigrationHandlers()
  }

  // Рассылка состояния игры всем участникам
  const broadcastGameState = () => {
    if (isHost.value) {
      peerService.broadcastMessage({
        type: 'game_state_update',
        payload: gameState.value
      })
    }
  }

  // Старт игры (только хост)
  const startGame = () => {
    if (!canStartGame.value) return
    
    gameState.value.gameStarted = true
    broadcastGameState()
  }

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
      peerService.sendMessage(hostId.value, {
        type: 'light_up_request',
        payload: { playerId: myPlayerId.value }
      })
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

  // Обработка отключения хоста
  const handleHostDisconnection = async () => {
    console.log('Host disconnection detected, starting secure migration...')
    
    if (migrationState.value.inProgress) {
      console.log('Migration already in progress, ignoring...')
      return
    }
    
    try {
      // Удаляем отключенного хоста из списка игроков
      const oldHostId = gameState.value.hostId
      gameState.value.players = gameState.value.players.filter(p => p.id !== oldHostId)
      
      // Проверяем токены оставшихся игроков
      const validPlayers = gameState.value.players.filter(validateAuthToken)
      if (validPlayers.length === 0) {
        throw new Error('No valid players remaining')
      }
      
      // Запускаем безопасную миграцию
      await startSecureMigration(validPlayers)
      
    } catch (error) {
      console.error('Host migration failed:', error)
      connectionStatus.value = 'disconnected'
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
      
    } catch (error) {
      console.error('Secure migration failed:', error)
      resetMigrationState()
      throw error
    }
  }

  // Выбор нового хоста из валидных игроков
  const electNewHostFromValidPlayers = (validPlayers: Player[]): Player => {
    // Сортируем по ID для детерминированности
    const sortedPlayers = validPlayers.sort((a, b) => a.id.localeCompare(b.id))
    
    if (sortedPlayers.length === 0) {
      throw new Error('No valid players for host election')
    }
    
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
    
    // Рассылаем через существующие соединения
    peerService.broadcastMessage({
      type: 'migration_proposal',
      payload: proposal
    })
    
    // Устанавливаем таймаут для голосования
    migrationState.value.timeout = window.setTimeout(() => {
      handleMigrationTimeout()
    }, VOTE_TIMEOUT)
    
    // Автоматически голосуем за себя
    migrationState.value.votes.set(myPlayerId.value, 'approve')
    
    // Ждем голосов от других игроков
    await waitForMigrationVotes()
  }

  // Участие в миграции (клиент)
  const participateInMigration = async (proposedHost: Player) => {
    console.log('Participating in migration, proposed host:', proposedHost.id)
    
    migrationState.value.phase = 'voting'
    
    // Настраиваем обработчик предложений миграции
    setupMigrationHandlers()
    
    // Автоматически одобряем предложение (можно добавить дополнительные проверки)
    const vote: MigrationVotePayload = {
      voterId: myPlayerId.value,
      voterToken: myPlayer.value?.authToken || '',
      proposedHostId: proposedHost.id,
      vote: 'approve',
      timestamp: Date.now()
    }
    
    // Отправляем голос предложенному хосту
    peerService.sendMessage(proposedHost.id, {
      type: 'migration_vote',
      payload: vote
    })
  }

  // Настройка обработчиков миграции
  const setupMigrationHandlers = () => {
    peerService.onMessage('migration_proposal', (message) => {
      const payload = message.payload as MigrationProposalPayload
      console.log('Received migration proposal:', payload)
      
      // Валидируем предложение
      if (validateMigrationProposal(payload)) {
        migrationState.value.proposedHostId = payload.proposedHostId
        migrationState.value.phase = 'voting'
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
    peerService.broadcastMessage({
      type: 'migration_confirmed',
      payload: confirmation
    })
    
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
    const myPlayerIndex = gameState.value.players.findIndex(p => p.id === myPlayerId.value)
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].isHost = true
    }
    
    // Создаем новое P2P соединение как хост
    const newPeerId = await peerService.createHost()
    
    // Уведомляем всех о новом ID
    const newHostMessage: NewHostIdPayload = {
      oldHostId: oldId,
      newHostId: newPeerId,
      newHostToken: myPlayer.value?.authToken || '',
      timestamp: Date.now()
    }
    
    // Отправляем через старые соединения перед их закрытием
    peerService.broadcastMessage({
      type: 'new_host_id',
      payload: newHostMessage
    })
    
    // Обновляем состояние
    myPlayerId.value = newPeerId
    gameState.value.hostId = newPeerId
    
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].id = newPeerId
    }
    
    // Запускаем heartbeat
    peerService.setAsHost(newPeerId)
    
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
      peerService.sendMessage(newHostId, {
        type: 'request_game_state',
        payload: { requesterId: myPlayerId.value }
      })
      
      connectionStatus.value = 'connected'
      console.log('Successfully migrated to new host')
      
      resetMigrationState()
    } catch (error) {
      console.error('Failed to finalize migration:', error)
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
  
  // Детерминированный алгоритм выборов нового хоста
  const electNewHost = (): string => {
    // Сортируем игроков по ID для детерминированности
    const remainingPlayers = gameState.value.players
      .filter(p => p.id !== gameState.value.hostId)
      .sort((a, b) => a.id.localeCompare(b.id))
    
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
    const myPlayerIndex = gameState.value.players.findIndex(p => p.id === myPlayerId.value)
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].isHost = true
    }
    
    // Создаем новое P2P соединение как хост
    const newPeerId = await peerService.createHost()
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
      peerService.sendMessage(newHostId, {
        type: 'request_game_state',
        payload: { requesterId: myPlayerId.value }
      })
      
      connectionStatus.value = 'connected'
      console.log('Successfully reconnected to new host')
    } catch (error) {
      console.error('Failed to reconnect to new host:', error)
      connectionStatus.value = 'disconnected'
      throw error
    }
  }
  
  // Уведомление о смене хоста
  const broadcastHostMigration = (newHostId: string) => {
    const migrationMessage: PeerMessage = {
      type: 'host_migration_started',
      payload: {
        newHostId,
        reason: 'host_disconnected'
      }
    }
    
    peerService.broadcastMessage(migrationMessage)
  }

  // Сохранение сессии в localStorage
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
      timestamp: Date.now()
    }
    
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionData))
    console.log('Session saved:', sessionData)
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
  
  // Восстановление состояния из сохраненной сессии
  const restoreSession = async (): Promise<boolean> => {
    const sessionData = loadSession()
    if (!sessionData) return false
    
    try {
      console.log('Attempting to restore session...')
      connectionStatus.value = 'connecting'
      
      // Восстанавливаем локальное состояние
      gameState.value = { ...sessionData.gameState }
      myPlayerId.value = sessionData.myPlayerId
      myNickname.value = sessionData.myNickname
      isHost.value = sessionData.isHost
      hostId.value = sessionData.hostId
      roomId.value = sessionData.roomId
      
      if (sessionData.isHost) {
        // Восстанавливаем как хост
        await restoreAsHost()
      } else {
        // Восстанавливаем как клиент
        await restoreAsClient(sessionData.hostId)
      }
      
      connectionStatus.value = 'connected'
      console.log('Session successfully restored')
      return true
    } catch (error) {
      console.error('Failed to restore session:', error)
      connectionStatus.value = 'disconnected'
      clearSession()
      return false
    }
  }
  
  // Восстановление хоста
  const restoreAsHost = async () => {
    console.log('Restoring as host...')
    
    // Создаем новое P2P соединение как хост
    const newPeerId = await peerService.createHost()
    
    // Обновляем ID хоста в состоянии
    const oldHostId = myPlayerId.value
    myPlayerId.value = newPeerId
    hostId.value = newPeerId
    gameState.value.hostId = newPeerId
    
    // Обновляем свой ID в списке игроков
    const myPlayerIndex = gameState.value.players.findIndex(p => p.id === oldHostId)
    if (myPlayerIndex !== -1) {
      gameState.value.players[myPlayerIndex].id = newPeerId
    }
    
    // Устанавливаем роль хоста и запускаем heartbeat
    peerService.setAsHost(newPeerId)
    
    // Настраиваем обработчики
    setupHostMessageHandlers()
    
    console.log('Host restored with new ID:', newPeerId)
  }
  
  // Восстановление клиента
  const restoreAsClient = async (targetHostId: string) => {
    console.log('Restoring as client, connecting to:', targetHostId)
    
    try {
      // Очищаем устаревшие данные о подсветке при восстановлении
      gameState.value.litUpPlayerId = null
      console.log('Cleared stale litUpPlayerId on session restore')
      
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
      
      // Ждем немного для установки соединения
      await new Promise(resolve => setTimeout(resolve, 500))
      
      // Отправляем запрос с правильным старым ID для поиска существующего игрока
      peerService.sendMessage(targetHostId, {
        type: 'join_request',
        payload: { 
          nickname: myNickname.value,
          savedPlayerId: originalPlayerId // Используем СТАРЫЙ ID для поиска существующего игрока
        }
      })
      
      // Ждем немного для обработки подключения
      await new Promise(resolve => setTimeout(resolve, 300))
      
      // Запрашиваем актуальное состояние игры
      peerService.sendMessage(targetHostId, {
        type: 'request_game_state',
        payload: { requesterId: myPlayerId.value }
      })
      
      // Ждем получения обновленного состояния
      await waitForGameStateUpdate()
      
      console.log('Client restored and reconnected with updated state')
    } catch (error) {
      console.error('Failed to restore as client:', error)
      // Если не удалось подключиться к старому хосту, пытаемся найти нового
      await handleHostDisconnection()
    }
  }

  // Ожидание обновления состояния игры
  const waitForGameStateUpdate = (): Promise<void> => {
    return new Promise((resolve) => {
      let attempts = 0
      const maxAttempts = 10
      
      const checkForUpdate = () => {
        attempts++
        
        // Проверяем, что у нас есть актуальные данные игроков
        const hasValidPlayers = gameState.value.players.length > 0 && 
                               gameState.value.players.some(p => p.nickname && p.nickname !== '')
        
        // Проверяем корректность litUpPlayerId - если указан, то игрок должен существовать
        const litUpPlayerValid = !gameState.value.litUpPlayerId || 
                                gameState.value.players.some(p => p.id === gameState.value.litUpPlayerId)
        
        if ((hasValidPlayers && litUpPlayerValid) || attempts >= maxAttempts) {
          // Очищаем некорректный litUpPlayerId если игрок не найден
          if (gameState.value.litUpPlayerId && !litUpPlayerValid) {
            console.log('Clearing invalid litUpPlayerId:', gameState.value.litUpPlayerId)
            gameState.value.litUpPlayerId = null
          }
          
          console.log('Game state synchronized, players:', gameState.value.players.length, 
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
      createdAt: 0
    }
    
    myPlayerId.value = ''
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

  // Автоматическое сохранение сессии при изменениях
  watch(
    [gameState, myPlayerId, myNickname, isHost, hostId, roomId, connectionStatus],
    () => {
      // Сохраняем только если подключены
      if (connectionStatus.value === 'connected' && myPlayerId.value) {
        saveSession()
      }
    },
    { deep: true }
  )

  return {
    // State
    gameState,
    myPlayerId,
    myNickname,
    isHost,
    hostId,
    roomId,
    connectionStatus,
    
    // Computed
    canStartGame,
    myPlayer,
    canJoinRoom,
    
    // Actions
    createRoom,
    joinRoom,
    startGame,
    lightUpPlayer,
    leaveRoom,
    broadcastGameState,
    
    // Session Management
    saveSession,
    restoreSession,
    hasActiveSession,
    clearSession
  }
})
