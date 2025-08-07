// hostMigration.ts - Готовая функция для миграции хоста с поддержкой сохранения peer ID
import type { GameState, Player } from '@/types/game'
import { peerService } from '@/services/peerSelector'

/**
 * Запускает процесс миграции хоста после обнаружения его отключения.
 * Логика детерминирована и не требует обмена сообщениями между клиентами для выборов.
 *
 * @param currentState - Текущее состояние игры, известное клиенту.
 * @param myCurrentId - PeerJS ID текущего клиента.
 * @param roomId - ID комнаты для сохранения peer ID
 * @returns {Promise<void>}
 */
export async function handleHostMigration(
  currentState: GameState,
  myCurrentId: string,
  roomId: string,
): Promise<void> {
  console.log('HOST MIGRATION: Process started.')

  // 1. Фильтруем игроков, удаляя старого хоста
  const remainingPlayers = currentState.players.filter((p) => p.id !== currentState.hostId)

  if (remainingPlayers.length === 0) {
    console.log('HOST MIGRATION: No players left. Ending game.')
    // Здесь должна быть логика завершения игры, например, вызов leaveRoom()
    // leaveRoom();
    return
  }

  // 2. ДЕТЕРМИНИРОВАННЫЙ ВЫБОР НОВОГО ХОСТА
  // Сортируем оставшихся игроков по их PeerJS ID.
  // Это гарантирует, что все клиенты выберут одного и того же кандидата.
  const sortedPlayers = [...remainingPlayers].sort((a, b) => a.id.localeCompare(b.id))
  const newHostCandidate = sortedPlayers[0]

  console.log(
    `HOST MIGRATION: New host candidate elected: ${newHostCandidate.nickname} (${newHostCandidate.id})`,
  )

  try {
    // 3. Разделение логики: становлюсь ли я хостом или подключаюсь к новому?
    if (newHostCandidate.id === myCurrentId) {
      // Я избран новым хостом
      await becomeNewHost(currentState, myCurrentId, roomId)
    } else {
      // Другой игрок избран хостом, я должен к нему подключиться
      await reconnectToNewHost(newHostCandidate.id, myCurrentId, currentState)
    }
  } catch (error) {
    console.error('HOST MIGRATION: Migration failed catastrophically.', error)
    // Здесь также вызываем логику выхода из комнаты
    // leaveRoom();
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
): Promise<void> {
  console.log('BECOME NEW HOST: Initializing...')

  // 1. КРИТИЧНО: Создаем новый PeerJS instance с сохранением ID для комнаты
  const newHostPeerId = await peerService.createHost(roomId)
  console.log(`BECOME NEW HOST: Host peer ID (may be restored): ${newHostPeerId}`)

  // 2. Обновляем локальное состояние и gameState
  // Это критически важно: gameState теперь будет содержать новый ID хоста.
  const updatedGameState = updateStateForNewHost(currentState, myOldId, newHostPeerId)

  // 3. Обновляем store/состояние приложения
  // updateMyPlayerId(newHostPeerId);
  // setIsHost(true);
  // setHostId(newHostPeerId);
  // updateGameState(updatedGameState);

  // 4. Настраиваем обработчики для нового хоста и запускаем heartbeat
  // setupHostMessageHandlers();
  // peerService.setAsHost(newHostPeerId);

  console.log('BECOME NEW HOST: Successfully transitioned to host role.')
}

/**
 * Логика для клиента, который должен переподключиться к новому хосту.
 */
async function reconnectToNewHost(
  newHostId: string,
  myCurrentId: string,
  currentState?: GameState,
): Promise<void> {
  console.log(`RECONNECT: Attempting to connect to new host ${newHostId}...`)

  // 1. Используем peerService для переподключения.
  // Эта функция в peerService должна закрыть старые соединения и открыть новое.
  await peerService.reconnectToNewHost(newHostId)

  // 2. Обновляем store/состояние приложения
  // setIsHost(false);
  // setHostId(newHostId);
  // updateGameState( ... ) // gameState обновится, когда придет от нового хоста

  // 3. Настраиваем обработчики клиента и мониторинг heartbeat
  // setupClientMessageHandlers();
  // peerService.setAsClient();

  // 4. Отправляем запрос на присоединение.
  // Очень важно отправить свой ТЕКУЩИЙ ID, чтобы новый хост мог найти нас в списке игроков.
  // Требуется полный JoinRequestPayload (минимум nickname), плюс savedPlayerId как опциональное поле
  peerService.sendMessage(newHostId, {
    type: 'join_request',
    protocolVersion: 1,
    meta: {
      roomId: currentState?.roomId || '',
      fromId: myCurrentId,
      ts: Date.now(),
    },
    payload: {
      nickname:
        currentState?.players.find((p: Player) => p.id === myCurrentId)?.nickname || 'Player',
      savedPlayerId: myCurrentId,
    },
  })

  console.log(`RECONNECT: Connection request sent to new host.`)
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
  oldHostId: string,
  newHostId: string,
): GameState {
  const newState = { ...oldState }

  // Обновляем ID хоста в корневом объекте
  newState.hostId = newHostId

  // Находим игрока, который стал хостом, и обновляем его данные
  const hostPlayer = newState.players.find((p) => p.id === oldHostId)
  if (hostPlayer) {
    hostPlayer.id = newHostId // Обновляем его PeerJS ID
    hostPlayer.isHost = true // Устанавливаем флаг хоста
  }

  // Снимаем флаг хоста со всех остальных на всякий случай
  newState.players.forEach((p) => {
    if (p.id !== newHostId) {
      p.isHost = false
    }
  })

  return newState
}
