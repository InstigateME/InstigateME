import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
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
import { peerService } from '@/services/peerService'
import { 
  MIGRATION_TIMEOUT, 
  VOTE_TIMEOUT, 
  HOST_DISCOVERY_TIMEOUT, 
  HOST_GRACE_PERIOD,
  MESH_RESTORATION_DELAY 
} from '@/types/game'

// Ключи для localStorage
const SESSION_STORAGE_KEY = 'gameSessionData'
const SESSION_TIMEOUT = 30 * 60 * 1000 // 30 минут

interface SessionData extends ExtendedSessionData {
  // Наследуем все поля от ExtendedSessionData для совместимости
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
  const restorationState = ref<'idle' | 'discovering' | 'restoring'>('idle')

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
      
      // КРИТИЧНО: Всегда пытаемся восстановить хоста с существующим ID
      const existingSession = loadSession()
      let restoredPeerId: string
      let targetRoomId: string
      
      if (existingSession && existingSession.isHost) {
        console.log('🔄 MANDATORY: Restoring host session for room:', existingSession.roomId)
        targetRoomId = existingSession.roomId
        
        // ОБЯЗАТЕЛЬНО передаем roomId для восстановления peer ID из localStorage
        restoredPeerId = await peerService.createHost(targetRoomId)
        
        console.log('📋 Restoring complete game state from saved session')
        myPlayerId.value = restoredPeerId
        myNickname.value = nickname
        isHost.value = true
        roomId.value = existingSession.roomId
        hostId.value = restoredPeerId
        gameState.value = { ...existingSession.gameState }
        gameState.value.hostId = restoredPeerId
        
        // Обновляем мой ID в списке игроков
        const myPlayerIndex = gameState.value.players.findIndex(p => p.isHost)
        if (myPlayerIndex !== -1) {
          gameState.value.players[myPlayerIndex].id = restoredPeerId
          gameState.value.players[myPlayerIndex].nickname = nickname
        }
        
        connectionStatus.value = 'connected'
        peerService.setAsHost(restoredPeerId)
        setupHostMessageHandlers()
        
        console.log('🎉 Host fully restored with session data - ID:', restoredPeerId)
        return restoredPeerId
        
      } else {
        // Создание полностью новой комнаты
        console.log('🆕 Creating brand new room')
        targetRoomId = generateRoomId()
        
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
          createdAt: now
        }
        
        // Добавляем хоста в список игроков
        const hostPlayer: Player = {
          id: restoredPeerId,
          nickname,
          color: generateRandomColor(),
          isHost: true,
          joinedAt: now,
          authToken: generateAuthToken(restoredPeerId, targetRoomId, now)
        }
        
        gameState.value.players = [hostPlayer]
      }
      
      connectionStatus.value = 'connected'
      
      // Устанавливаем роль хоста и запускаем heartbeat
      peerService.setAsHost(restoredPeerId)
      setupHostMessageHandlers()
      
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
      peerService.sendMessage(targetHostId, {
        type: 'join_request',
        payload: { nickname }
      })
      
      // КРИТИЧНО: Сразу запрашиваем список всех игроков для mesh-подключения
      peerService.sendMessage(targetHostId, {
        type: 'request_peer_list',
        payload: { 
          requesterId: myPlayerId.value,
          requesterToken: '',
          timestamp: Date.now()
        }
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
    
    // Добавляем обработчики host discovery
    setupHostDiscoveryHandlers()
    
    // Добавляем обработчики mesh-протокола
    setupMeshProtocolHandlers()
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
    
    // Добавляем обработчики host discovery
    setupHostDiscoveryHandlers()
    
    // Добавляем обработчики mesh-протокола
    setupMeshProtocolHandlers()
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
        
        // Отправляем запрос на подключение
        peerService.sendMessage(hostId, {
          type: 'join_request',
          payload: { 
            nickname: myNickname.value,
            savedPlayerId: myPlayerId.value
          }
        })
        
        // Запрашиваем актуальное состояние игры
        peerService.sendMessage(hostId, {
          type: 'request_game_state',
          payload: { requesterId: myPlayerId.value }
        })
        
        connectionStatus.value = 'connected'
        console.log('✅ Successfully reconnected to host:', hostId)
        return
        
      } catch (error) {
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
        currentGameStatePlayers: gameState.value.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost })),
        myPlayerId: myPlayerId.value,
        connectionStatus: connectionStatus.value,
        migrationInProgress: migrationState.value.inProgress,
        peerRecoveryState: peerService.getHostRecoveryState()
      })
      
      // Удаляем отключенного хоста из списка игроков
      const playersBeforeFilter = gameState.value.players.length
      gameState.value.players = gameState.value.players.filter(p => p.id !== originalHostId)
      const playersAfterFilter = gameState.value.players.length
      
      console.log('🔍 PLAYER FILTERING:', {
        originalHostId,
        playersBeforeFilter,
        playersAfterFilter,
        remainingPlayers: gameState.value.players.map(p => ({ id: p.id, nickname: p.nickname, authToken: !!p.authToken }))
      })
      
      // Проверяем токены оставшихся игроков
      const validPlayers = gameState.value.players.filter(validateAuthToken)
      console.log('🔍 TOKEN VALIDATION:', {
        totalPlayers: gameState.value.players.length,
        validPlayers: validPlayers.length,
        invalidPlayers: gameState.value.players.filter(p => !validateAuthToken(p)).map(p => ({ id: p.id, nickname: p.nickname, hasToken: !!p.authToken }))
      })
      
      if (validPlayers.length === 0) {
        throw new Error('No valid players remaining after grace period')
      }
      
      console.log('Valid players remaining after grace period:', validPlayers.map(p => ({ id: p.id, nickname: p.nickname })))
      
      // Быстрая проверка - может кто-то уже стал хостом во время grace period
      console.log('Final check: Quick host discovery among remaining players...')
      console.log('🔍 DISCOVERY ATTEMPT STATE:', {
        validPlayersCount: validPlayers.length,
        peerState: peerService.getCurrentRole(),
        myPeerId: peerService.getMyId(),
        activeConnections: peerService.getActiveConnections()
      })
      
      const discoveredHost = await quickHostDiscovery(validPlayers)
      
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
      const openConnections = activeConnections.filter(c => c.isOpen)
      console.log('🔍 CONNECTION ANALYSIS:', {
        totalConnections: activeConnections.length,
        openConnections: openConnections.length,
        connectionDetails: activeConnections.map(c => ({ peerId: c.peerId, isOpen: c.isOpen })),
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
          validPlayersForElection: validPlayers.map(p => ({ id: p.id, nickname: p.nickname }))
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
      
    } catch (error) {
      console.error('❌ Failed to proceed with migration after grace period:', error)
      console.log('🔍 MIGRATION ERROR STATE:', {
        error: error.message,
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
            } catch (e) { /* ignore */ }
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
      peerService.sendMessage(discoveredHost.currentHostId, {
        type: 'request_game_state',
        payload: { requesterId: myPlayerId.value }
      })
      
      connectionStatus.value = 'connected'
      console.log('Successfully reconnected to discovered host')
      
    } catch (error) {
      console.error('Failed to reconnect to discovered host:', error)
      connectionStatus.value = 'disconnected'
      throw error
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
    // Сортируем по nickname для детерминированности (как в electHostDeterministic)
    const sortedPlayers = validPlayers.sort((a, b) => a.nickname.localeCompare(b.nickname))
    
    if (sortedPlayers.length === 0) {
      throw new Error('No valid players for host election')
    }
    
    console.log('🔍 HOST ELECTION ALGORITHM:', {
      validPlayers: validPlayers.map(p => ({ id: p.id, nickname: p.nickname })),
      sortedPlayers: sortedPlayers.map(p => ({ id: p.id, nickname: p.nickname })),
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
        peerService.sendMessage(player.id, {
          type: 'migration_proposal',
          payload: proposal
        })
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
        currentPlayers: gameState.value.players.map(p => ({ id: p.id, nickname: p.nickname, authToken: !!p.authToken })),
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
        
        peerService.sendMessage(payload.proposedHostId, {
          type: 'migration_vote',
          payload: vote
        })
        
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
    
    // КРИТИЧНО: Передаем roomId для сохранения нового peer ID хоста
    const newPeerId = await peerService.createHost(roomId.value)
    
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
    const sortedPlayers = validPlayers.sort((a, b) => a.nickname.localeCompare(b.nickname))
    
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
      const myPlayerIndex = gameState.value.players.findIndex(p => p.id === myPlayerId.value)
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
        peerService.broadcastToAllPeers({
          type: 'host_recovery_announcement',
          payload: recoveryAnnouncement
        })
        
        console.log('📢 Sent host recovery announcement to all peers')
      }, MESH_RESTORATION_DELAY)
      
      // Также рассылаем обычное уведомление о смене хоста для совместимости
      broadcastHostMigration(newPeerId)
      
      connectionStatus.value = 'connected'
      
    } catch (error) {
      console.error('❌ Failed to become host with recovery:', error)
      connectionStatus.value = 'disconnected'
      throw error
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
      
      // Восстанавливаем локальное состояние
      gameState.value = { ...sessionData.gameState }
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
    } catch (error) {
      console.error('Failed to restore session:', error)
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
    const savedPlayers = sessionData.gameState.players.filter(p => !p.isHost && p.id !== sessionData.myPlayerId)
    if (savedPlayers.length > 0) {
      console.log('Strategy 2: Polling saved players:', savedPlayers.map(p => p.id))
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
      
      const request = message.payload as HostDiscoveryRequestPayload
      console.log('Received host discovery request:', request)
      
      const response: HostDiscoveryResponsePayload = {
        responderId: myPlayerId.value,
        responderToken: myPlayer.value?.authToken || '',
        isHost: isHost.value,
        currentHostId: gameState.value.hostId,
        gameState: gameState.value,
        timestamp: Date.now()
      }
      
      // Отправляем ответ
      conn.send({
        type: 'host_discovery_response',
        payload: response
      })
      
      console.log('Sent host discovery response:', response)
    })
  }

  // Настройка mesh-протокола для P2P соединений между всеми игроками
  const setupMeshProtocolHandlers = () => {
    console.log('Setting up mesh protocol handlers')
    
    // Обработка запроса списка peer'ов
    peerService.onMessage('request_peer_list', (message, conn) => {
      if (!conn) return
      
      const request = message.payload as PeerListRequestPayload
      console.log('Received peer list request:', request)
      
      // Отправляем список всех игроков запросившему
      const peerListUpdate: PeerListUpdatePayload = {
        peers: gameState.value.players,
        fromPlayerId: myPlayerId.value,
        timestamp: Date.now()
      }
      
      conn.send({
        type: 'peer_list_update',
        payload: peerListUpdate
      })
      
      console.log('Sent peer list to:', request.requesterId, 'players:', gameState.value.players.length)
    })
    
    // Обработка обновления списка peer'ов
    peerService.onMessage('peer_list_update', async (message) => {
      const update = message.payload as PeerListUpdatePayload
      console.log('🔗 Received peer list update:', update)
      
      // Добавляем всех peer'ов в известные
      const peerIds = update.peers.map(p => p.id)
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
      
      const request = message.payload as DirectConnectionRequestPayload
      console.log('Received direct connection request:', request)
      
      // Добавляем peer'а в известные
      peerService.addKnownPeer(request.requesterId)
      
      // Соединение уже установлено через conn, просто логируем
      console.log('Direct connection established with:', request.requesterId)
    })
    
    // Обработка синхронизации состояния
    peerService.onMessage('state_sync', (message) => {
      const sync = message.payload as StateSyncPayload
      console.log('Received state sync:', sync)
      
      // Если получили более свежее состояние игры - обновляем
      if (sync.timestamp > gameState.value.createdAt) {
        console.log('Updating to newer game state from:', sync.fromPlayerId)
        gameState.value = { ...sync.gameState }
      }
    })
    
    // Обработка выборов нового хоста
    peerService.onMessage('new_host_election', (message) => {
      const election = message.payload as NewHostElectionPayload
      console.log('Received host election:', election)
      
      // Проверяем валидность кандидата
      const candidate = gameState.value.players.find(p => p.id === election.candidateId)
      if (candidate && candidate.authToken === election.candidateToken) {
        // Обновляем хоста если консенсус достигнут
        const totalPlayers = gameState.value.players.length
        const supportingPlayers = election.electorsConsensus.length
        
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
      const announcement = message.payload as HostRecoveryAnnouncementPayload
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
      gameState.value = { ...announcement.gameState }
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
          } catch (error) {
            console.error('❌ Failed to reconnect to recovered host:', error)
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
    
    // КРИТИЧНО: Передаем roomId для восстановления сохраненного peer ID
    const newPeerId = await peerService.createHost(roomId.value)
    
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
    
    console.log('Host restored with ID (may be same as before):', newPeerId)
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
      
      // КРИТИЧНО: Добавляем mesh-обработчики при восстановлении
      setupMeshProtocolHandlers()
      
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
    // КРИТИЧНО: Очищаем сохраненный peer ID хоста при покидании комнаты
    if (roomId.value && isHost.value) {
      console.log('🗑️ Clearing saved host peer ID for room:', roomId.value)
      peerService.clearSavedHostId(roomId.value)
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
