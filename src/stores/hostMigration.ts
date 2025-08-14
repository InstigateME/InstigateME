// hostMigration.ts - Готовая функция для миграции хоста с поддержкой сохранения peer ID
import type { GameState, Player } from '@/types/game'
import { makeMessage } from '@/types/game'
import { peerService } from '@/services/peerSelector'

/**
 * Запускает процесс миграции хоста после обнаружения его отключения.
 * Логика детерминирована и не требует обмена сообщениями между клиентами для выборов.
 *
 * @param currentState - Текущее состояние игры, известное клиенту.
 * @param myCurrentId - PeerJS ID текущего клиента.
 * @param roomId - ID комнаты для сохранения peer ID
 * @param callbacks - Функции обратного вызова для обновления gameStore
 * @returns {Promise<void>}
 */
export async function handleHostMigration(
  currentState: GameState,
  myCurrentId: string,
  roomId: string,
  callbacks?: {
    updateGameState: (state: GameState) => void
    updateMyPlayerId: (id: string) => void
    setIsHost: (isHost: boolean) => void
    setHostId: (hostId: string) => void
    setupHostHandlers: () => void
    setupClientHandlers: () => void
  },
): Promise<void> {
  console.log('🚀 HOST MIGRATION: Process started.')
  console.log('🔍 HOST MIGRATION: Input parameters:', {
    currentHostId: currentState.hostId,
    myCurrentId,
    roomId,
    totalPlayers: currentState.players.length,
    players: currentState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
  })

  // 1. Фильтруем игроков, удаляя старого хоста
  const remainingPlayers = currentState.players.filter((p) => p.id !== currentState.hostId)
  console.log('🧹 HOST MIGRATION: Filtered players (removed old host):', {
    oldHostId: currentState.hostId,
    remainingPlayersCount: remainingPlayers.length,
    remainingPlayers: remainingPlayers.map(p => ({ id: p.id, nickname: p.nickname }))
  })

  if (remainingPlayers.length === 0) {
    console.log('❌ HOST MIGRATION: No players left. Ending game.')
    // Здесь должна быть логика завершения игры, например, вызов leaveRoom()
    // leaveRoom();
    return
  }

  // 2. ДЕТЕРМИНИРОВАННЫЙ ВЫБОР НОВОГО ХОСТА
  // Используем сортировку по client ID (peer ID) - выбираем минимальный ID
  // Это обеспечивает детерминированность независимо от nickname или времени подключения
  
  const sortedPlayers = remainingPlayers.sort((a, b) => {
    // Сортируем по peer ID (client ID) лексикографически 
    const clientIdA = a.id || ''
    const clientIdB = b.id || ''
    return clientIdA.localeCompare(clientIdB)
  })
  const newHostCandidate = sortedPlayers[0]

  console.log('👑 HOST MIGRATION: New host selection:', {
    algorithm: 'client ID based (minimum peer ID)',
    allCandidates: sortedPlayers.map(p => ({ 
      id: p.id, 
      nickname: p.nickname,
      joinedAt: p.joinedAt
    })),
    selectedHost: { 
      id: newHostCandidate.id, 
      nickname: newHostCandidate.nickname
    },
    amITheNewHost: newHostCandidate.id === myCurrentId,
    expectedResult: 'Client with minimum peer ID should be selected as new host'
  })

  try {
    // 3. Разделение логики: становлюсь ли я хостом или подключаюсь к новому?
    if (newHostCandidate.id === myCurrentId) {
      // Я избран новым хостом
      console.log('🏠 HOST MIGRATION: I am the new host, calling becomeNewHost...')
      await becomeNewHost(currentState, myCurrentId, roomId, callbacks)
      console.log('✅ HOST MIGRATION: becomeNewHost completed successfully')
    } else {
      // Другой игрок избран хостом, я должен к нему подключиться
      console.log('🔗 HOST MIGRATION: Connecting to new host, calling reconnectToNewHost...')
      
      // КРИТИЧЕСКИ ВАЖНО: Даем новому хосту время на инициализацию
      // Детерминированная задержка основанная на позиции в списке
      const myIndex = sortedPlayers.findIndex(p => p.id === myCurrentId)
      const reconnectDelay = Math.max(1000, myIndex * 500) // Минимум 1с, +0.5с за каждую позицию
      
      console.log(`🔗 HOST MIGRATION: Waiting ${reconnectDelay}ms before connecting (position ${myIndex})`)
      await new Promise(resolve => setTimeout(resolve, reconnectDelay))
      
      await reconnectToNewHost(newHostCandidate.id, myCurrentId, currentState, callbacks)
      console.log('✅ HOST MIGRATION: reconnectToNewHost completed successfully')
    }
    console.log('🎉 HOST MIGRATION: Migration process completed successfully')
  } catch (error) {
    console.error('💥 HOST MIGRATION: Migration failed catastrophically.', error)
    console.error('💥 HOST MIGRATION: Error stack:', (error as any)?.stack)
    // Здесь также вызываем логику выхода из комнаты
    // leaveRoom();
    throw error // Re-throw to let caller handle it
  }
}

/**
 * Логика для игрока, который был избран новым хостом.
 * Он создает новый PeerJS-объект и готовится принимать подключения.
 * КРИТИЧНО: Передает roomId для сохранения peer ID хоста.
 */
async function becomeNewHost(
  currentState: GameState,
  myOldId: string,
  roomId: string,
  callbacks?: {
    updateGameState: (state: GameState) => void
    updateMyPlayerId: (id: string) => void
    setIsHost: (isHost: boolean) => void
    setHostId: (hostId: string) => void
    setupHostHandlers: () => void
    setupClientHandlers: () => void
  },
): Promise<void> {
  console.log('🏠 BECOME NEW HOST: Initializing...')
  console.log('🏠 BECOME NEW HOST: Input params:', {
    myOldId,
    roomId,
    currentStateHostId: currentState.hostId,
    currentStatePlayers: currentState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
  })

  try {
    // 1. КРИТИЧНО: Создаем новый PeerJS instance с сохранением ID для комнаты
    console.log('🏠 BECOME NEW HOST: Step 1 - Creating host peer...')
    const newHostPeerId = await peerService.createHost(roomId)
    console.log(`🏠 BECOME NEW HOST: Host peer ID created: ${newHostPeerId}`)

    // 2. Обновляем локальное состояние и gameState
    console.log('🏠 BECOME NEW HOST: Step 2 - Updating game state...')
    // Это критически важно: gameState теперь будет содержать новый ID хоста.
    // Сначала создаем состояние без старого хоста
    const stateWithoutOldHost = {
      ...currentState,
      players: currentState.players.filter((p) => p.id !== currentState.hostId)
    }
    console.log('🏠 BECOME NEW HOST: State without old host:', {
      oldHostId: currentState.hostId,
      remainingPlayers: stateWithoutOldHost.players.map(p => ({ id: p.id, nickname: p.nickname }))
    })
    
    const updatedGameState = updateStateForNewHost(stateWithoutOldHost, myOldId, newHostPeerId)
    console.log('🏠 BECOME NEW HOST: Updated game state details:', {
      oldPlayerId: myOldId,
      newPlayerId: newHostPeerId,
      playersBefore: stateWithoutOldHost.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost })),
      playersAfter: updatedGameState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
    })
    console.log('🏠 BECOME NEW HOST: Final game state after update:', {
      hostId: updatedGameState.hostId,
      players: updatedGameState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
    })

    // 3. Обновляем store/состояние приложения
    console.log('🏠 BECOME NEW HOST: Step 3 - Updating store state...')
    if (callbacks) {
      console.log('🏠 BECOME NEW HOST: Calling callbacks...')
      callbacks.updateMyPlayerId(newHostPeerId)
      console.log('🏠 BECOME NEW HOST: Updated my player ID to:', newHostPeerId)
      
      callbacks.setIsHost(true)
      console.log('🏠 BECOME NEW HOST: Set isHost to true')
      
      callbacks.setHostId(newHostPeerId)
      console.log('🏠 BECOME NEW HOST: Set hostId to:', newHostPeerId)
      
      callbacks.updateGameState(updatedGameState)
      console.log('🏠 BECOME NEW HOST: Updated game state via callback')
      
      callbacks.setupHostHandlers()
      console.log('🏠 BECOME NEW HOST: Set up host handlers')
    } else {
      console.warn('🏠 BECOME NEW HOST: No callbacks provided!')
    }

    // 4. Настраиваем peer service как хост
    console.log('🏠 BECOME NEW HOST: Step 4 - Configuring peer service as host...')
    peerService.setAsHost(newHostPeerId, roomId)
    console.log('🏠 BECOME NEW HOST: Peer service configured as host')

    console.log('✅ BECOME NEW HOST: Successfully transitioned to host role.')
    
    // 5. КРИТИЧЕСКИЙ БАГФИКС: Добавляем задержку и принудительную рассылку состояния
    // После того как клиенты переподключатся, нужно убедиться что они получили актуальное состояние с правильными флагами isHost
    console.log('🏠 BECOME NEW HOST: State ready for incoming client connections')
    
    // КРИТИЧЕСКИЙ БАГФИКС: Несколько волн принудительной рассылки для обеспечения синхронизации
    const broadcastStateWithRetries = (attempt: number = 1, maxAttempts: number = 3) => {
      console.log(`🔄 BECOME NEW HOST: Broadcasting state (attempt ${attempt}/${maxAttempts}) to ensure all clients have correct host flags`)
      console.log('🔄 BECOME NEW HOST: State to broadcast:', {
        hostId: updatedGameState.hostId,
        players: updatedGameState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
      })
      
      // Используем правильный формат сообщения с makeMessage
      const stateMessage = makeMessage(
        'game_state_update',
        updatedGameState,
        {
          roomId: updatedGameState.roomId,
          fromId: newHostPeerId,
          ts: Date.now()
        }
      )
      
      // ДИАГНОСТИКА: Проверяем активные соединения перед рассылкой
      const currentConnections = peerService.getActiveConnections()
      console.log(`🔄 BECOME NEW HOST: Current connections before broadcast:`, {
        connectionsCount: currentConnections.length,
        connectionIds: currentConnections.map(c => c.peerId)
      })
      
      peerService.broadcastMessage(stateMessage)
      console.log(`🔄 BECOME NEW HOST: State broadcast attempt ${attempt} completed`)
      
      // Дополнительные попытки с увеличивающимися интервалами
      if (attempt < maxAttempts) {
        const nextDelay = attempt * 1500; // 1.5s, 3s, 4.5s
        setTimeout(() => broadcastStateWithRetries(attempt + 1, maxAttempts), nextDelay);
      }
    }
    
    // Первая волна через 2 секунды
    setTimeout(() => broadcastStateWithRetries(1, 3), 2000)
    
  } catch (error) {
    console.error('💥 BECOME NEW HOST: Error during host transition:', error)
    console.error('💥 BECOME NEW HOST: Error stack:', (error as any)?.stack)
    throw error
  }
}

/**
 * Логика для клиента, который должен переподключиться к новому хосту.
 */
async function reconnectToNewHost(
  newHostId: string,
  myCurrentId: string,
  currentState?: GameState,
  callbacks?: {
    updateGameState: (state: GameState) => void
    updateMyPlayerId: (id: string) => void
    setIsHost: (isHost: boolean) => void
    setHostId: (hostId: string) => void
    setupHostHandlers: () => void
    setupClientHandlers: () => void
  },
): Promise<void> {
  console.log(`🔗 RECONNECT: Attempting to connect to new host ${newHostId}...`)
  console.log('🔗 RECONNECT: Input params:', {
    newHostId,
    myCurrentId,
    hasCurrentState: !!currentState,
    hasCallbacks: !!callbacks,
    currentStatePlayers: currentState?.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost })) || []
  })

  try {
    // 1. Подключение к новому хосту с ретраями
    console.log('🔗 RECONNECT: Step 1 - Attempting connection with retries...')
    
    const maxRetries = 5
    let connected = false
    
    for (let attempt = 1; attempt <= maxRetries && !connected; attempt++) {
      try {
        console.log(`🔗 RECONNECT: Connection attempt ${attempt}/${maxRetries} to host ${newHostId}`)
        await peerService.reconnectToNewHost(newHostId)
        connected = true
        console.log('✅ RECONNECT: PeerService reconnection completed')
      } catch (error) {
        console.warn(`❌ RECONNECT: Attempt ${attempt} failed:`, error)
        if (attempt < maxRetries) {
          const retryDelay = Math.min(1000 * attempt, 3000) // 1s, 2s, 3s, 3s, 3s
          console.log(`⏳ RECONNECT: Retrying in ${retryDelay}ms...`)
          await new Promise(resolve => setTimeout(resolve, retryDelay))
        }
      }
    }
    
    if (!connected) {
      throw new Error(`Failed to connect to new host ${newHostId} after ${maxRetries} attempts`)
    }

    // 2. Обновляем store/состояние приложения
    console.log('🔗 RECONNECT: Step 2 - Updating store state...')
    if (callbacks) {
      console.log('🔗 RECONNECT: Updating callbacks...')
      
      callbacks.setIsHost(false)
      console.log('🔗 RECONNECT: Set isHost to false')
      
      callbacks.setHostId(newHostId)
      console.log('🔗 RECONNECT: Set hostId to:', newHostId)
      
      callbacks.setupClientHandlers()
      console.log('🔗 RECONNECT: Set up client handlers')
      
      // Обновляем gameState - удаляем старого хоста, так как он больше не участвует в игре
      if (currentState) {
        const updatedState = { ...currentState }
        updatedState.hostId = newHostId
        // ВАЖНО: Удаляем старого хоста из списка игроков
        const oldHostId = currentState.hostId
        updatedState.players = updatedState.players.filter(p => p.id !== oldHostId)
        // Обновляем хостовский статус у игроков - снимаем isHost со всех
        updatedState.players.forEach((p) => {
          p.isHost = false
        })
        console.log('🔗 RECONNECT: Updated local game state (waiting for host sync):', {
          newHostId: updatedState.hostId,
          oldHostId,
          removedOldHost: true,
          players: updatedState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
        })
        callbacks.updateGameState(updatedState)
        console.log('🔗 RECONNECT: Local game state updated, waiting for authoritative state from new host')
      } else {
        console.warn('🔗 RECONNECT: No current state provided for update')
      }
    } else {
      console.warn('🔗 RECONNECT: No callbacks provided!')
    }

    // 3. Отправляем запрос на присоединение.
    console.log('🔗 RECONNECT: Step 3 - Sending join request to new host...')
    // Очень важно отправить свой ТЕКУЩИЙ ID, чтобы новый хост мог найти нас в списке игроков.
    // Требуется полный JoinRequestPayload (минимум nickname), плюс savedPlayerId как опциональное поле
    const nickname = currentState?.players.find((p: Player) => p.id === myCurrentId)?.nickname || 'Player'
    const joinMessage = makeMessage('join_request', {
      nickname,
      savedPlayerId: myCurrentId,
    }, {
      roomId: currentState?.roomId || '',
      fromId: myCurrentId,
      ts: Date.now(),
    })
    
    console.log('🔗 RECONNECT: Join message details:', {
      type: joinMessage.type,
      nickname,
      savedPlayerId: myCurrentId,
      roomId: currentState?.roomId
    })
    
    peerService.sendMessage(newHostId, joinMessage)
    console.log(`✅ RECONNECT: Connection request sent to new host ${newHostId}`)
    
    // 4. КРИТИЧЕСКИЙ БАГФИКС: Восстанавливаем mesh-соединения с остальными клиентами
    console.log('🕸️ RECONNECT: Step 4 - Rebuilding mesh connections with other clients...')
    if (currentState) {
      // Получаем список всех оставшихся игроков кроме себя и нового хоста
      const otherClients = currentState.players.filter(p => 
        p.id !== myCurrentId && 
        p.id !== newHostId && 
        p.id !== currentState.hostId // исключаем старого хоста
      )
      
      console.log('🕸️ RECONNECT: Other clients to reconnect to:', otherClients.map(p => ({ id: p.id, nickname: p.nickname })))
      
      // Запрашиваем peer list у нового хоста для получения актуальных ID
      peerService.sendMessage(newHostId, makeMessage(
        'request_peer_list',
        { 
          requesterId: myCurrentId, 
          requesterToken: '', 
          timestamp: Date.now() 
        },
        {
          roomId: currentState.roomId,
          fromId: myCurrentId,
          ts: Date.now()
        }
      ))
      
      console.log('🕸️ RECONNECT: Peer list requested for mesh rebuilding')
    }
    
  } catch (error) {
    console.error('💥 RECONNECT: Error during reconnection:', error)
    console.error('💥 RECONNECT: Error stack:', (error as any)?.stack)
    throw error
  }
}

/**
 * Вспомогательная функция для обновления объекта gameState после смены хоста.
 * @param oldState - Предыдущее состояние игры.
 * @param oldHostId - Старый PeerJS ID игрока, который становится хостом.
 * @param newHostId - Новый PeerJS ID этого же игрока.
 * @returns {GameState} - Обновленное состояние игры.
 */
function updateStateForNewHost(
  oldState: GameState,
  oldPlayerId: string,
  newHostId: string,
): GameState {
  console.log('🔄 updateStateForNewHost called with:', {
    oldPlayerId,
    newHostId,
    currentPlayers: oldState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
  })
  
  const newState = { ...oldState }

  // Обновляем ID хоста в корневом объекте
  newState.hostId = newHostId

  // КРИТИЧЕСКИЙ БАГФИКС: Находим игрока по тому же алгоритму что и в handleHostMigration
  // Ищем игрока с минимальным client ID (peer ID) среди оставшихся
  
  // Сначала попробуем найти по oldPlayerId (может сработать если ID не менялся)
  let hostPlayer = newState.players.find((p) => p.id === oldPlayerId)
  
  if (!hostPlayer) {
    // Если не нашли по ID, ищем игрока с минимальным client ID - используем тот же алгоритм
    const sortedPlayers = newState.players.sort((a, b) => {
      const clientIdA = a.id || ''
      const clientIdB = b.id || ''
      return clientIdA.localeCompare(clientIdB)
    })
    
    hostPlayer = sortedPlayers[0] // Игрок с минимальным client ID
    console.log('🔄 Looking for host by client ID sorting:', {
      allPlayersInState: newState.players.map(p => ({ id: p.id, nickname: p.nickname })),
      sortedPlayers: sortedPlayers.map(p => ({ id: p.id, nickname: p.nickname })),
      selectedByMinClientId: hostPlayer ? { id: hostPlayer.id, nickname: hostPlayer.nickname } : null
    })
  }
  
  if (hostPlayer) {
    console.log('🔄 Found player to promote to host:', {
      foundBy: hostPlayer.id === oldPlayerId ? 'peer ID' : 'client ID sorting',
      oldId: hostPlayer.id,
      nickname: hostPlayer.nickname,
      newHostId
    })
    
    hostPlayer.id = newHostId // Обновляем его PeerJS ID на новый host ID
    hostPlayer.isHost = true  // Устанавливаем флаг хоста
  } else {
    // ЭТОГО БОЛЬШЕ НЕ ДОЛЖНО ПРОИСХОДИТЬ при правильной логике
    console.error('💥 КРИТИЧЕСКАЯ ОШИБКА: Не удалось найти игрока для назначения хостом!')
    console.error('💥 Состояние игроков:', newState.players.map(p => ({ id: p.id, nickname: p.nickname })))
    console.error('💥 oldPlayerId:', oldPlayerId)
    
    // Создаем fallback только в крайнем случае
    const newHostPlayer = {
      id: newHostId,
      nickname: 'FALLBACK Host Player', 
      isHost: true,
      color: '#FF6B6B',
      joinedAt: Date.now(),
      authToken: '',
      votingCards: ['Карточка 1', 'Карточка 2'],
      bettingCards: ['0', '±', '+'],
    }
    newState.players.push(newHostPlayer)
    console.log('🆘 Created EMERGENCY fallback host player:', newHostPlayer)
  }

  // Снимаем флаг хоста со всех остальных
  newState.players.forEach((p) => {
    if (p.id !== newHostId) {
      p.isHost = false
    }
  })

  console.log('🔄 Updated state result:', {
    hostId: newState.hostId,
    players: newState.players.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.isHost }))
  })

  return newState
}
