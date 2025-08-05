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

export type GamePhase =
  | 'lobby'
  | 'drawing_question'
  | 'voting'
  | 'secret_voting'
  | 'betting'
  | 'results'
  | 'answering'
  | 'guessing'
  | 'advanced_results'
  | 'game_over';

export type GameMode = 'basic' | 'advanced';

export interface GameState {
  roomId: string // Постоянный ID комнаты
  gameStarted: boolean
  players: Player[] // Упорядоченный массив для детерминированных выборов
  litUpPlayerId: string | null
  maxPlayers: number
  hostId: string // Текущий ID хоста
  createdAt: number // Время создания комнаты

  // Общая игровая логика
  gameMode?: GameMode
  phase?: GamePhase

  questionCards: string[] // Карточки с вопросами
  currentQuestion?: string | null

  // Ход/очередность
  currentTurn?: number // Индекс текущего игрока (совместимость со старым кодом)
  currentTurnPlayerId?: string | null // Явный ID текущего игрока

  // Раундовые данные
  votingCards: Record<string, string[]> // Карточки голосования для каждого игрока
  bettingCards: Record<string, string[]> // Карточки ставок для каждого игрока
  votes?: Record<string, string[]> // { voterId: [targetId, targetId] }
  voteCounts?: Record<string, number> // агрегированные голоса по целям
  bets?: Record<string, '0' | '+-' | '+'> // { playerId: bet }
  scores: Record<string, number> // Очки игроков
  roundScores?: Record<string, number> // Очки конкретного раунда

  // Для режима 2.0 (advanced)
  answeringPlayerId?: string | null
  advancedAnswer?: string | null
  answers?: Record<string, string>
  guesses?: Record<string, string>

  // Финал
  winnerName?: string | null
}

export const PROTOCOL_VERSION = 1

// Метаданные сообщения
export interface MessageMeta {
  roomId: string
  fromId: string
  ts: number
}

// Базовый каркас сообщений с версией протокола и метаданными
export interface BaseMessage<TType extends string, TPayload> {
  type: TType
  protocolVersion: number
  payload: TPayload
  meta: MessageMeta
}

// Сообщения лобби и базовой связи
export type JoinRequestMessage = BaseMessage<'join_request', JoinRequestPayload & { savedPlayerId?: string }>
export type GameStateUpdateMessage = BaseMessage<'game_state_update', GameState>
export type LightUpRequestMessage = BaseMessage<'light_up_request', LightUpRequestPayload>
export type StartGameMessage = BaseMessage<'start_game', { mode: GameMode }>
export type HeartbeatMessage = BaseMessage<'heartbeat', HeartbeatPayload>
export type RequestGameStateMessage = BaseMessage<'request_game_state', GameStateRequestPayload>
export type ConnectionErrorMessage = BaseMessage<'connection_error', { code: string; message: string }>

// Миграция хоста
export type MigrationProposalMessage = BaseMessage<'migration_proposal', MigrationProposalPayload>
export type MigrationVoteMessage = BaseMessage<'migration_vote', MigrationVotePayload>
export type MigrationConfirmedMessage = BaseMessage<'migration_confirmed', MigrationConfirmedPayload>
export type NewHostIdMessage = BaseMessage<'new_host_id', NewHostIdPayload>
export type HostMigrationStartedMessage = BaseMessage<'host_migration_started', HostMigrationPayload>

// Host discovery
export type HostDiscoveryRequestMessage = BaseMessage<'host_discovery_request', HostDiscoveryRequestPayload>
export type HostDiscoveryResponseMessage = BaseMessage<'host_discovery_response', HostDiscoveryResponsePayload>

// Mesh / Peer list / Direct connect
export type PeerListRequestMessage = BaseMessage<'request_peer_list', PeerListRequestPayload>
export type PeerListUpdateMessage = BaseMessage<'peer_list_update', PeerListUpdatePayload>
export type DirectConnectionRequestMessage = BaseMessage<'direct_connection_request', DirectConnectionRequestPayload>

// Синхронизация состояния/версий сети
export type StateSyncMessage = BaseMessage<'state_sync', StateSyncPayload>
export type NewHostElectionMessage = BaseMessage<'new_host_election', NewHostElectionPayload>

// Восстановление хоста и слияние сетей
export type HostRecoveryAnnouncementMessage = BaseMessage<'host_recovery_announcement', HostRecoveryAnnouncementPayload>
export type NetworkMergeRequestMessage = BaseMessage<'network_merge_request', NetworkMergeRequestPayload>
export type NetworkMergeResponseMessage = BaseMessage<'network_merge_response', NetworkMergeResponsePayload>
export type SplitBrainDetectionMessage = BaseMessage<'split_brain_detection', SplitBrainDetectionPayload>
export type PlayerIdUpdatedMessage = BaseMessage<'player_id_updated', { oldId: string; newId: string; message?: string }>

// Игровые сообщения (Провокатор)
export type DrawQuestionRequestMessage = BaseMessage<'draw_question_request', DrawQuestionRequestPayload>
export type SubmitVoteMessage = BaseMessage<'submit_vote', SubmitVotePayload>
export type SubmitBetMessage = BaseMessage<'submit_bet', SubmitBetPayload>
export type SubmitAnswerMessage = BaseMessage<'submit_answer', SubmitAnswerPayload>
export type SubmitGuessMessage = BaseMessage<'submit_guess', SubmitGuessPayload>
export type NextRoundRequestMessage = BaseMessage<'next_round_request', { playerId: string }>

// Дискриминируемый юнион всех сообщений
export type PeerMessage =
  | JoinRequestMessage
  | GameStateUpdateMessage
  | LightUpRequestMessage
  | StartGameMessage
  | HeartbeatMessage
  | HostMigrationStartedMessage
  | RequestGameStateMessage
  | ConnectionErrorMessage
  | MigrationProposalMessage
  | MigrationVoteMessage
  | MigrationConfirmedMessage
  | NewHostIdMessage
  | HostDiscoveryRequestMessage
  | HostDiscoveryResponseMessage
  | PeerListRequestMessage
  | PeerListUpdateMessage
  | DirectConnectionRequestMessage
  | StateSyncMessage
  | NewHostElectionMessage
  | HostRecoveryAnnouncementMessage
  | NetworkMergeRequestMessage
  | NetworkMergeResponseMessage
  | SplitBrainDetectionMessage
  | PlayerIdUpdatedMessage
  | DrawQuestionRequestMessage
  | SubmitVoteMessage
  | SubmitBetMessage
  | SubmitAnswerMessage
  | SubmitGuessMessage
  | NextRoundRequestMessage

// Утилита для конструирования исходящих сообщений
export function makeMessage<TType extends PeerMessage['type']>(
  type: TType,
  payload: Extract<PeerMessage, { type: TType }>['payload'],
  meta: MessageMeta
): Extract<PeerMessage, { type: TType }> {
  return {
    type,
    payload,
    protocolVersion: PROTOCOL_VERSION,
    meta,
  } as Extract<PeerMessage, { type: TType }>
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

// Полезные типы полезной нагрузки для игровых сообщений
export interface DrawQuestionRequestPayload {
  playerId?: string // клиент может указать себя явно, хост может игнорировать
}

export interface SubmitVotePayload {
  voterId: string
  targetIds: string[] // длиной до 2
}

export interface SubmitBetPayload {
  playerId: string
  bet: '0' | '+-' | '+'
}

export interface SubmitAnswerPayload {
  playerId: string
  answer: string
}

export interface SubmitGuessPayload {
  playerId: string
  guess: string
}
