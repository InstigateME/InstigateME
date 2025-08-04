export interface Player {
  id: string
  nickname: string
  color: string
  isHost: boolean
  joinedAt: number // Время подключения для упорядочивания
}

export interface GameState {
  roomId: string // Постоянный ID комнаты
  gameStarted: boolean
  players: Player[] // Упорядоченный массив для детерминированных выборов
  litUpPlayerId: string | null
  maxPlayers: number
  hostId: string // Текущий ID хоста
  createdAt: number // Время создания комнаты
}

export interface PeerMessage {
  type: 'join_request' | 'game_state_update' | 'light_up_request' | 'start_game' | 
        'heartbeat' | 'host_migration_started' | 'request_game_state' | 'connection_error'
  payload?: any
}

export interface JoinRequestPayload {
  nickname: string
}

export interface LightUpRequestPayload {
  playerId: string
}

export interface HeartbeatPayload {
  timestamp: number
  hostId: string
}

export interface HostMigrationPayload {
  newHostId: string
  reason: 'host_disconnected' | 'manual_transfer'
}

export interface GameStateRequestPayload {
  requesterId: string
}

// Константы для таймингов
export const HEARTBEAT_INTERVAL = 2000 // 2 секунды
export const HEARTBEAT_TIMEOUT = 5000 // 5 секунд
export const RECONNECTION_TIMEOUT = 10000 // 10 секунд для переподключения
