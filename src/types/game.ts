export interface Player {
  id: string
  nickname: string
  color: string
  isHost: boolean
  joinedAt: number
  authToken: string
  votingCards: string[] // Cards for voting
  bettingCards: string[] // Cards for betting
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
  | 'selecting_winners'
  | 'advanced_results'
  | 'game_over'

export type GameMode = 'basic' | 'advanced'

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

  questionIndices?: number[] // Индексы вопросов (перемешанная колода)
  currentQuestion?: number | null

  // Ход/очередность
  currentTurn?: number // Индекс текущего игрока (совместимость со старым кодом)
  currentTurnPlayerId?: string | null // Явный ID текущего игрока

  // Раундовые данные
  votingCards: Record<string, string[]> // Карточки голосования для каждого игрока
  bettingCards: Record<string, string[]> // Карточки ставок для каждого игрока
  votes?: Record<string, string[]> // { voterId: [targetId, targetId] }
  voteCounts?: Record<string, number> // агрегированные голоса по целям
  bets?: Record<string, '0' | '±' | '+'> // { playerId: bet }
  scores: Record<string, number> // Очки игроков
  roundScores?: Record<string, number> // Очки конкретного раунда

  // Для режима 2.0 (advanced)
  answeringPlayerId?: string | null
  advancedAnswer?: string | null
  answers?: Record<string, string>
  guesses?: Record<string, string>

  // Advanced winners selection
  roundWinners?: string[]

  // Финал
  winnerName?: string | null

  // Присутствие игроков
  presence?: Record<string, 'present' | 'absent'>
  presenceMeta?: Record<
    string,
    {
      lastSeen: number
      leftAt?: number
      reason?: 'explicit_leave' | 'presence_timeout' | 'connection_closed'
    }
  >
}

import { PROTOCOL_VERSION as PROTOCOL_VERSION_CONFIG } from '@/config/gameConfig'

export const PROTOCOL_VERSION = PROTOCOL_VERSION_CONFIG

// ===== Versioned sync protocol (backward-compatible) =====

// Common version meta for versioned state messages
export interface StateVersionMeta {
  roomId: string
  version: number
  prevVersion?: number
  serverTime: number
}

// Snapshot envelope: authoritative full state from host
export interface StateSnapshotPayload {
  meta: StateVersionMeta
  state: GameState
}

// Diff envelope: incremental patch from host
export type JsonPatch = Record<string, any> | null

export interface StateDiffPayload {
  meta: StateVersionMeta
  // Patch semantics: deep-merge + null means delete a key
  patch: JsonPatch
}

// Ack from client for specific version
export interface StateAckPayload {
  roomId: string
  version: number
  receivedAt: number
}

// Resync request from client when gap detected or no init
export interface ResyncRequestPayload {
  roomId: string
  fromVersion?: number
  reason: 'gap' | 'init_missing' | 'late_join' | 'reconnect'
}

// Control message confirming join and echoing server meta
export interface JoinOkPayload {
  roomId: string
  hostId: string
  serverTime: number
  // Latest known version on host at the moment of join
  latestVersion?: number
}

// Backward-compatible new message types
export type JoinOkMessage = BaseMessage<'join_ok', JoinOkPayload>
export type StateSnapshotMessage = BaseMessage<'state_snapshot', StateSnapshotPayload>
export type StateDiffMessage = BaseMessage<'state_diff', StateDiffPayload>
export type StateAckMessage = BaseMessage<'state_ack', StateAckPayload>
export type ResyncRequestMessage = BaseMessage<'resync_request', ResyncRequestPayload>

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
export type JoinRequestMessage = BaseMessage<
  'join_request',
  JoinRequestPayload & { savedPlayerId?: string }
>
export type GameStateUpdateMessage = BaseMessage<'game_state_update', GameState>
export type LightUpRequestMessage = BaseMessage<'light_up_request', LightUpRequestPayload>
export type StartGameMessage = BaseMessage<'start_game', { mode: GameMode }>
export type HeartbeatMessage = BaseMessage<'heartbeat', HeartbeatPayload>
export type RequestGameStateMessage = BaseMessage<'request_game_state', GameStateRequestPayload>
export type ConnectionErrorMessage = BaseMessage<
  'connection_error',
  { code: string; message: string }
>

// Presence / оставление комнаты
export type UserLeftRoomMessage = BaseMessage<'user_left_room', UserLeftRoomPayload>
export type UserJoinedBroadcastMessage = BaseMessage<
  'user_joined_broadcast',
  UserJoinedBroadcastPayload
>
export type UserLeftBroadcastMessage = BaseMessage<'user_left_broadcast', UserLeftBroadcastPayload>
export type HostLeftRoomMessage = BaseMessage<'host_left_room', HostLeftRoomPayload>

// Host discovery (simplified - no migration)

// Host discovery
export type HostDiscoveryRequestMessage = BaseMessage<
  'host_discovery_request',
  HostDiscoveryRequestPayload
>
export type HostDiscoveryResponseMessage = BaseMessage<
  'host_discovery_response',
  HostDiscoveryResponsePayload
>

// Mesh / Peer list / Direct connect - removed for hub-and-spoke
export type DirectConnectionRequestMessage = BaseMessage<
  'direct_connection_request',
  DirectConnectionRequestPayload
>

// Синхронизация состояния/версий сети
export type StateSyncMessage = BaseMessage<'state_sync', StateSyncPayload>
export type NewHostElectionMessage = BaseMessage<'new_host_election', NewHostElectionPayload>

// Восстановление хоста и слияние сетей
export type HostRecoveryAnnouncementMessage = BaseMessage<
  'host_recovery_announcement',
  HostRecoveryAnnouncementPayload
>
export type NetworkMergeRequestMessage = BaseMessage<
  'network_merge_request',
  NetworkMergeRequestPayload
>
export type NetworkMergeResponseMessage = BaseMessage<
  'network_merge_response',
  NetworkMergeResponsePayload
>
export type SplitBrainDetectionMessage = BaseMessage<
  'split_brain_detection',
  SplitBrainDetectionPayload
>
export type PlayerIdUpdatedMessage = BaseMessage<
  'player_id_updated',
  { oldId: string; newId: string; message?: string }
>

// Удален - mesh networking больше не используется

// Игровые сообщения (Провокатор)
export type DrawQuestionRequestMessage = BaseMessage<
  'draw_question_request',
  DrawQuestionRequestPayload
>
export type SubmitVoteMessage = BaseMessage<'submit_vote', SubmitVotePayload>
export type SubmitBetMessage = BaseMessage<'submit_bet', SubmitBetPayload>
export type SubmitAnswerMessage = BaseMessage<'submit_answer', SubmitAnswerPayload>
export type SubmitGuessMessage = BaseMessage<'submit_guess', SubmitGuessPayload>
export type NextRoundRequestMessage = BaseMessage<'next_round_request', { playerId: string }>
export type SubmitWinnersMessage = BaseMessage<
  'submit_winners',
  { chooserId: string; winners: string[] }
>

// Дискриминируемый юнион всех сообщений
export type PeerMessage =
  | JoinRequestMessage
  | GameStateUpdateMessage
  | LightUpRequestMessage
  | StartGameMessage
  | HeartbeatMessage
  | RequestGameStateMessage
  | ConnectionErrorMessage
  | HostDiscoveryRequestMessage
  | HostDiscoveryResponseMessage
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
  | VoteAckMessage
  | AnswerAckMessage
  | GuessAckMessage
  | NextRoundRequestMessage
  | SubmitWinnersMessage
  // Presence
  | UserLeftRoomMessage
  | UserJoinedBroadcastMessage
  | UserLeftBroadcastMessage
  | HostLeftRoomMessage
  // Versioned sync protocol (backward-compatible)
  | JoinOkMessage
  | StateSnapshotMessage
  | StateDiffMessage
  | StateAckMessage
  | ResyncRequestMessage

// Утилита для конструирования исходящих сообщений
export function makeMessage<TType extends PeerMessage['type']>(
  type: TType,
  payload: Extract<PeerMessage, { type: TType }>['payload'],
  meta: MessageMeta,
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

export interface GameStateRequestPayload {
  requesterId: string
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

// Peer Discovery Protocol - removed peer list requests for hub-and-spoke architecture

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

// Импортируем константы из конфигурации
import { GAME_CONFIG } from '@/config/gameConfig'

// Экспортируем константы для обратной совместимости
export const HEARTBEAT_INTERVAL = GAME_CONFIG.HEARTBEAT_INTERVAL
export const HEARTBEAT_TIMEOUT = GAME_CONFIG.HEARTBEAT_TIMEOUT
export const RECONNECTION_TIMEOUT = GAME_CONFIG.RECONNECTION_TIMEOUT
export const HOST_DISCOVERY_TIMEOUT = GAME_CONFIG.HOST_DISCOVERY_TIMEOUT
export const HOST_GRACE_PERIOD = GAME_CONFIG.HOST_GRACE_PERIOD
export const HOST_RECOVERY_ATTEMPTS = GAME_CONFIG.HOST_RECOVERY_ATTEMPTS
export const HOST_RECOVERY_INTERVAL = GAME_CONFIG.HOST_RECOVERY_INTERVAL
export const MESH_RESTORATION_DELAY = GAME_CONFIG.MESH_RESTORATION_DELAY
export const PRESENCE_REJOIN_GRACE = GAME_CONFIG.PRESENCE_REJOIN_GRACE

// Полезные типы полезной нагрузки для игровых сообщений
export interface DrawQuestionRequestPayload {
  playerId?: string // клиент может указать себя явно, хост может игнорировать
}

// Presence payloads
export interface UserLeftRoomPayload {
  userId: string
  roomId: string
  timestamp: number
  currentScore?: number
  reason: 'explicit_leave' | 'presence_timeout' | 'connection_closed'
}

export interface UserJoinedBroadcastPayload {
  userId: string
  roomId: string
  timestamp: number
}

export interface UserLeftBroadcastPayload {
  userId: string
  roomId: string
  timestamp: number
  reason: 'explicit_leave' | 'presence_timeout' | 'connection_closed'
}

export interface HostLeftRoomPayload {
  hostId: string
  reason: 'voluntary_leave' | 'force_disconnect'
}

export interface SubmitVotePayload {
  voterId: string
  targetIds: string[] // до 2 голосов (можно два за одного игрока)
  stateVersion?: number
}

export interface SubmitBetPayload {
  playerId: string
  bet: '0' | '±' | '+'
  stateVersion?: number
}

export interface SubmitAnswerPayload {
  playerId: string
  answer: string
}

export interface SubmitGuessPayload {
  playerId: string
  guess: string
}

// --- VoteAck ---
export interface VoteAckPayload {
  voterId: string
  stateVersion?: number
  targetIds?: string[]
  // можно добавить другие поля по необходимости
}
export type VoteAckMessage = BaseMessage<'vote_ack', VoteAckPayload>

// Answer and Guess ACK payloads
export interface AnswerAckPayload {
  playerId: string
  answer: string
}
export type AnswerAckMessage = BaseMessage<'answer_ack', AnswerAckPayload>

export interface GuessAckPayload {
  playerId: string
  guess: string
}
export type GuessAckMessage = BaseMessage<'guess_ack', GuessAckPayload>
