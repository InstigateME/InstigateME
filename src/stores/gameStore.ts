import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type { Player, GameState, PeerMessage } from '@/types/game'
import { peerService } from '@/services/peerService'

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
    gameState.value.players.length < gameState.value.maxPlayers && !gameState.value.gameStarted
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
        joinedAt: now
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
    peerService.onMessage('join_request', (message, conn) => {
      if (!canJoinRoom.value || !conn) return
      
      const { nickname } = message.payload
      const newPlayer: Player = {
        id: conn.peer,
        nickname,
        color: generateRandomColor(),
        isHost: false,
        joinedAt: Date.now()
      }
      
      gameState.value.players.push(newPlayer)
      
      // Отправляем обновленное состояние всем игрокам
      broadcastGameState()
    })

    peerService.onMessage('light_up_request', (message) => {
      const { playerId } = message.payload
      
      if (gameState.value.gameStarted) {
        gameState.value.litUpPlayerId = playerId
        broadcastGameState()
        
        // Убираем подсветку через 2 секунды
        setTimeout(() => {
          gameState.value.litUpPlayerId = null
          broadcastGameState()
        }, 2000)
      }
    })
    
    peerService.onMessage('request_game_state', (message, conn) => {
      if (!conn) return
      
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
    if (!gameState.value.gameStarted || !myPlayerId.value) return
    
    if (isHost.value) {
      // Хост обрабатывает запрос локально
      gameState.value.litUpPlayerId = myPlayerId.value
      broadcastGameState()
      
      setTimeout(() => {
        gameState.value.litUpPlayerId = null
        broadcastGameState()
      }, 2000)
    } else {
      // Клиент отправляет запрос хосту
      peerService.sendMessage(hostId.value, {
        type: 'light_up_request',
        payload: { playerId: myPlayerId.value }
      })
    }
  }

  // Обработка отключения хоста
  const handleHostDisconnection = async () => {
    console.log('Host disconnection detected, starting leader election...')
    
    try {
      // Удаляем отключенного хоста из списка игроков
      const oldHostId = gameState.value.hostId
      gameState.value.players = gameState.value.players.filter(p => p.id !== oldHostId)
      
      // Детерминированный выбор нового хоста
      const newHostId = electNewHost()
      
      if (newHostId === myPlayerId.value) {
        // Я становлюсь новым хостом
        await becomeNewHost()
      } else {
        // Переподключаюсь к новому хосту
        await reconnectToNewHost(newHostId)
      }
    } catch (error) {
      console.error('Host migration failed:', error)
      connectionStatus.value = 'disconnected'
    }
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

  // Покинуть комнату
  const leaveRoom = () => {
    peerService.disconnect()
    
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
    broadcastGameState
  }
})
