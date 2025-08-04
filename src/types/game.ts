export interface Player {
  id: string;
  nickname: string;
  color: string;
  isHost: boolean;
  joinedAt: number;
  authToken: string;
  votingCards: string[]; // Cards for voting
  bettingCards: string[]; // Cards for betting
}

export interface GameState {
  roomId: string // Постоянный ID комнаты
  gameStarted: boolean
  players: Player[] // Упорядоченный массив для детерминированных выборов
  litUpPlayerId: string | null
  maxPlayers: number
  hostId: string // Текущий ID хоста
  createdAt: number // Время создания комнаты
  questionCards: string[] // Карточки с вопросами
  votingCards: Record<string, string[]> // Карточки голосования для каждого игрока
  bettingCards: Record<string, string[]> // Карточки ставок для каждого игрока
  currentTurn: number // Индекс текущего игрока
  scores: Record<string, number> // Очки игроков
  // Для режима 2.0 (advanced)
  answers?: Record<string, string>
  guesses?: Record<string, string>
}

export interface PeerMessage {
  type: 'join_request' | 'game_state_update' | 'light_up_request' | 'start_game' | 
        'heartbeat' | 'host_migration_started' | 'request_game_state' | 'connection_error' |
        'migration_proposal' | 'migration_vote' | 'migration_confirmed' | 'new_host_id' |
        'host_discovery_request' | 'host_discovery_response' |
        'request_peer_list' | 'peer_list_update' | 'direct_connection_request' |
        'state_sync' | 'new_host_election' | 'host_recovery_announcement' | 
        'network_merge_request' | 'network_merge_response' | 'split_brain_detection' | 'player_id_updated'
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

export interface MigrationProposalPayload {
  proposedHostId: string
  proposedHostToken: string
  reason: 'host_disconnected' | 'manual_transfer'
  timestamp: number
}

export interface MigrationVotePayload {
  voterId: string
  voterToken: string
  proposedHostId: string
  vote: 'approve' | 'reject'
  timestamp: number
}

export interface MigrationConfirmedPayload {
  newHostId: string
  newHostToken: string
  confirmedBy: string[]
  timestamp: number
}

export interface NewHostIdPayload {
  oldHostId: string
  newHostId: string
  newHostToken: string
  timestamp: number
}

export interface HostDiscoveryRequestPayload {
  requesterId: string
  requesterToken: string
  timestamp: number
}

export interface HostDiscoveryResponsePayload {
  responderId: string
  responderToken: string
  isHost: boolean
  currentHostId: string
  gameState: GameState
  timestamp: number
}

// Peer Discovery Protocol
export interface PeerListRequestPayload {
  requesterId: string
  requesterToken: string
  timestamp: number
}

export interface PeerListUpdatePayload {
  peers: Player[]
  fromPlayerId: string
  timestamp: number
}

export interface DirectConnectionRequestPayload {
  requesterId: string
  requesterNickname: string
  requesterToken: string
  timestamp: number
}

export interface StateSyncPayload {
  gameState: GameState
  fromPlayerId: string
  timestamp: number
  version: number
}

export interface NewHostElectionPayload {
  candidateId: string
  candidateToken: string
  electorsConsensus: string[] // список ID игроков, поддерживающих кандидата
  timestamp: number
}

// Новые интерфейсы для восстановления состояния
export interface HostRecoveryAnnouncementPayload {
  originalHostId: string
  recoveredHostId: string
  roomId: string
  gameState: GameState
  recoveryTimestamp: number
  meshTopology: string[] // список всех peer ID для восстановления
}

export interface NetworkMergeRequestPayload {
  requestingHostId: string
  requestingGameState: GameState
  requestingPlayers: Player[]
  mergeReason: 'host_recovery' | 'split_brain_resolution'
  timestamp: number
}

export interface NetworkMergeResponsePayload {
  respondingHostId: string
  mergeDecision: 'accept' | 'reject' | 'defer'
  currentGameState: GameState
  conflictResolution?: 'use_newer' | 'use_larger_network' | 'manual'
  timestamp: number
}

export interface SplitBrainDetectionPayload {
  detectorId: string
  conflictingHosts: string[]
  networkStates: GameState[]
  detectionTimestamp: number
}

// Расширенные данные сессии для восстановления
export interface ExtendedSessionData {
  gameState: GameState
  myPlayerId: string
  myNickname: string
  isHost: boolean
  hostId: string
  roomId: string
  timestamp: number
  meshTopology: string[] // полная топология mesh-сети
  lastHeartbeat: number
  networkVersion: number // версия сети для обнаружения конфликтов
}

// Константы для таймингов
export const HEARTBEAT_INTERVAL = 2000 // 2 секунды
export const HEARTBEAT_TIMEOUT = 5000 // 5 секунд
export const RECONNECTION_TIMEOUT = 10000 // 10 секунд для переподключения
export const MIGRATION_TIMEOUT = 15000 // 15 секунд на миграцию
export const VOTE_TIMEOUT = 5000 // 5 секунд на голосование
export const HOST_DISCOVERY_TIMEOUT = 3000 // 3 секунды на опрос хоста
export const HOST_GRACE_PERIOD = 8000 // 8 секунд ожидания восстановления хоста
export const HOST_RECOVERY_ATTEMPTS = 3 // Количество попыток восстановления
export const HOST_RECOVERY_INTERVAL = 2000 // Интервал между попытками восстановления
export const MESH_RESTORATION_DELAY = 1000 // Задержка восстановления mesh-соединений
