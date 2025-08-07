/**
 * In-memory mock of PeerService compatible API, switchable by ?mockPeer=1.
 * Simulates rooms, hosts, clients, messaging, heartbeat, and basic versioned sync helpers.
 * No real network/WebRTC — uses a global event bus per "peerId".
 */

import type { PeerMessage, MessageMeta, HeartbeatPayload } from '@/types/game'
import type {
  StateSnapshotPayload,
  StateDiffPayload,
  StateAckPayload,
  ResyncRequestPayload,
} from '@/types/game'
import { PROTOCOL_VERSION, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT } from '@/types/game'

type Handler = (data: PeerMessage, fromId?: string) => void

interface MockConn {
  from: string
  to: string
  open: boolean
}

interface PeerRecord {
  id: string
  inboxHandlers: Map<string, Handler>
  connections: Map<string, MockConn> // key: peerId
  isHost: boolean
  roomId: string | null
  heartbeatInterval: number | null
  lastHeartbeatAt: number
  heartbeatTimers: Map<string, number>
  onHostDisconnected?: (() => void) | null
  onClientDisconnected?: ((peerId: string) => void) | null
  onClientReconnected?: ((peerId: string) => void) | null
  onHostRecovered?: (() => void) | null
}

interface RoomRecord {
  roomId: string
  hostId: string | null
  peers: Set<string>
}

const GLOBAL = globalThis as any
GLOBAL.__mockPeerBus = GLOBAL.__mockPeerBus || {
  peers: new Map<string, PeerRecord>(),
  rooms: new Map<string, RoomRecord>(),
}

function genId(): string {
  // not crypto-strong; enough for tests
  return 'm_' + Math.random().toString(36).slice(2, 10)
}

function ensurePeer(id: string): PeerRecord {
  const bus = GLOBAL.__mockPeerBus
  if (!bus.peers.has(id)) {
    bus.peers.set(id, {
      id,
      inboxHandlers: new Map(),
      connections: new Map(),
      isHost: false,
      roomId: null,
      heartbeatInterval: null,
      lastHeartbeatAt: 0,
      heartbeatTimers: new Map(),
      onHostDisconnected: null,
      onClientDisconnected: null,
      onClientReconnected: null,
      onHostRecovered: null,
    })
  }
  return bus.peers.get(id)!
}

function sendDirect(toId: string, message: PeerMessage, fromId: string) {
  const rec = ensurePeer(toId)
  const handler = rec.inboxHandlers.get(message.type)
  if (handler) {
    try {
      handler(message, fromId)
    } catch (e) {
      console.warn('[mockPeer] handler failed', e)
    }
  }
}

/**
 * Minimal API-compatible mock service
 */
class MockPeerService {
  private me: PeerRecord | null = null

  // host/client role
  private isHostRole = false

  private currentRoomId: string | null = null

  async createHost(roomId?: string): Promise<string> {
    const id = genId()
    this.me = ensurePeer(id)
    this.isHostRole = true
    this.me.isHost = true
    this.currentRoomId = roomId || 'r_' + Math.random().toString(36).slice(2, 8)
    this.me.roomId = this.currentRoomId

    // register room
    const bus = GLOBAL.__mockPeerBus
    let room = bus.rooms.get(this.currentRoomId)
    if (!room) {
      room = { roomId: this.currentRoomId, hostId: id, peers: new Set([id]) }
      bus.rooms.set(this.currentRoomId, room)
    } else {
      room.hostId = id
      room.peers.add(id)
    }

    // start heartbeat
    this.startHeartbeat(id)

    return id
  }

  async connectToHost(hostId: string): Promise<void> {
    // create me
    const id = genId()
    this.me = ensurePeer(id)
    this.isHostRole = false
    this.me.isHost = false

    // join host's room if exists
    const bus = GLOBAL.__mockPeerBus
    const host = ensurePeer(hostId)
    const roomId = host.roomId || 'r_' + Math.random().toString(36).slice(2, 8)
    this.currentRoomId = roomId
    this.me.roomId = roomId

    let room = bus.rooms.get(roomId)
    if (!room) {
      room = { roomId, hostId: hostId, peers: new Set() }
      bus.rooms.set(roomId, room)
    }
    room.peers.add(this.me.id)

    // create pseudo-connection both ways
    const c1: MockConn = { from: this.me.id, to: hostId, open: true }
    const c2: MockConn = { from: hostId, to: this.me.id, open: true }
    this.me.connections.set(hostId, c1)
    host.connections.set(this.me.id, c2)
  }

  private startHeartbeat(hostId: string) {
    if (!this.me) return
    if (this.me.heartbeatInterval) {
      clearInterval(this.me.heartbeatInterval)
    }
    this.me.heartbeatInterval = window.setInterval(() => {
      const meta: MessageMeta = {
        roomId: this.currentRoomId || '',
        fromId: this.getMyId() || hostId,
        ts: Date.now(),
      }
      const msg: PeerMessage = {
        type: 'heartbeat',
        protocolVersion: PROTOCOL_VERSION,
        meta,
        payload: { timestamp: Date.now(), hostId } as HeartbeatPayload,
      }
      this.broadcastMessage(msg)
    }, HEARTBEAT_INTERVAL)
  }

  handleHeartbeat(hostId: string) {
    if (!this.me) return
    this.me.lastHeartbeatAt = Date.now()
    // client-side timeout watcher
    const prev = this.me.heartbeatTimers.get(hostId)
    if (prev) clearTimeout(prev)
    const t = window.setTimeout(() => {
      // host considered disconnected
      if (this.me?.onHostDisconnected) {
        try {
          this.me.onHostDisconnected()
        } catch {}
      }
    }, HEARTBEAT_TIMEOUT)
    this.me.heartbeatTimers.set(hostId, t)
  }

  onHostDisconnected(cb: () => void) {
    if (!this.me) return
    this.me.onHostDisconnected = cb
  }
  onClientDisconnected(cb: (peerId: string) => void) {
    if (!this.me) return
    this.me.onClientDisconnected = cb
  }
  onClientReconnected(cb: (peerId: string) => void) {
    if (!this.me) return
    this.me.onClientReconnected = cb
  }
  onHostRecovered(cb: () => void) {
    if (!this.me) return
    this.me.onHostRecovered = cb
  }

  // Mock for host recovery grace period
  isInHostRecoveryGracePeriod(): boolean {
    return false
  }

  cancelHostRecoveryGracePeriod() {
    // No-op for mock
  }

  getHostRecoveryState() {
    return {
      inGracePeriod: false,
      originalHostId: '',
      recoveryAttempts: 0,
      gracePeriodStart: 0,
      timeRemaining: 0,
    }
  }

  // Mock for clearing saved host ID
  clearSavedHostId(_roomId: string): void {
    // No-op for mock
  }

  sendMessage(peerId: string, message: PeerMessage) {
    const from = this.getMyId()
    if (!from) return
    sendDirect(peerId, message, from)
  }

  broadcastMessage(message: PeerMessage) {
    if (!this.me) return
    const from = this.me.id
    // broadcast to room peers except self
    const bus = GLOBAL.__mockPeerBus
    if (!this.currentRoomId) return
    const room = bus.rooms.get(this.currentRoomId)
    if (!room) return
    room.peers.forEach((pid: string) => {
      if (pid !== from) {
        sendDirect(pid, message, from)
      }
    })
  }

  onMessage(type: string, handler: Handler) {
    if (!this.me) return
    this.me.inboxHandlers.set(type, (msg: PeerMessage, from?: string) => handler(msg, from))
  }

  clearMessageHandlers() {
    if (!this.me) return
    this.me.inboxHandlers.clear()
  }

  getRegisteredHandlers(): string[] {
    if (!this.me) return []
    return Array.from(this.me.inboxHandlers.keys())
  }

  getMyId(): string | null {
    return this.me?.id || null
  }

  getConnectedPeers(): string[] {
    if (!this.me) return []
    return Array.from(this.me.connections.keys())
  }

  isHost(): boolean {
    return this.isHostRole
  }

  isClient(): boolean {
    return !this.isHostRole && !!this.me
  }

  setAsHost(hostId: string, roomId?: string) {
    if (!this.me) return
    this.isHostRole = true
    this.me.isHost = true
    this.currentRoomId = roomId || this.currentRoomId
    this.me.roomId = this.currentRoomId
    this.startHeartbeat(hostId)
  }

  setAsClient() {
    if (!this.me) return
    this.isHostRole = false
    if (this.me.heartbeatInterval) {
      clearInterval(this.me.heartbeatInterval)
      this.me.heartbeatInterval = null
    }
  }

  async reconnectToNewHost(newHostId: string): Promise<void> {
    if (!this.me) return
    const prev = Array.from(this.me.connections.keys())
    prev.forEach((pid) => this.me?.connections.delete(pid))
    // make connection to new host
    const host = ensurePeer(newHostId)
    const c1: MockConn = { from: this.me.id, to: newHostId, open: true }
    const c2: MockConn = { from: newHostId, to: this.me.id, open: true }
    this.me.connections.set(newHostId, c1)
    host.connections.set(this.me.id, c2)
  }

  isHostActive(): boolean {
    if (this.isHostRole) return true
    if (!this.me) return false
    return Date.now() - this.me.lastHeartbeatAt < HEARTBEAT_TIMEOUT
  }

  getLastHeartbeatTime(): number {
    return this.me?.lastHeartbeatAt || 0
  }

  getCurrentRole(): 'host' | 'client' | 'disconnected' {
    if (!this.me) return 'disconnected'
    return this.isHostRole ? 'host' : 'client'
  }

  // Mesh stubs for compatibility
  async connectToPeer(peerId: string): Promise<boolean> {
    if (!this.me) return false
    const p = ensurePeer(peerId)
    const c1: MockConn = { from: this.me.id, to: peerId, open: true }
    const c2: MockConn = { from: peerId, to: this.me.id, open: true }
    this.me.connections.set(peerId, c1)
    p.connections.set(this.me.id, c2)
    return true
  }
  async connectToAllPeers(peerIds: string[]): Promise<void> {
    await Promise.all(peerIds.map((id) => this.connectToPeer(id)))
  }
  broadcastToAllPeers(message: PeerMessage) {
    this.broadcastMessage(message)
  }
  getAllKnownPeers(): string[] {
    return this.getConnectedPeers()
  }
  addKnownPeer(_peerId: string) {}
  addKnownPeers(_peerIds: string[]) {}
  addConnection(peerId: string, _connection: any) {
    // treat as peer known
    if (!this.me) return
    if (!this.me.connections.has(peerId)) {
      const c: MockConn = { from: this.me.id, to: peerId, open: true }
      this.me.connections.set(peerId, c)
    }
  }
  hasConnection(peerId: string): boolean {
    if (!this.me) return false
    return this.me.connections.has(peerId)
  }
  getPeer(): any {
    // not applicable; return non-null to satisfy guards
    return { open: true, id: this.getMyId() }
  }
  getActiveConnections(): { peerId: string; isOpen: boolean }[] {
    if (!this.me) return []
    return Array.from(this.me.connections.entries()).map(([peerId, conn]) => ({
      peerId,
      isOpen: conn.open,
    }))
  }
  cleanupInactiveConnections() {
    return 0
  }

  // Room context
  setRoomContext(roomId: string | null) {
    this.currentRoomId = roomId
    if (this.me) this.me.roomId = roomId
  }

  // Presence helpers
  broadcastUserLeft(
    roomId: string,
    hostId: string,
    userId: string,
    reason: 'explicit_leave' | 'presence_timeout' | 'connection_closed',
    timestamp?: number,
  ) {
    const ts = timestamp || Date.now()
    const msg: PeerMessage = {
      type: 'user_left_broadcast',
      protocolVersion: PROTOCOL_VERSION,
      meta: { roomId, fromId: hostId, ts },
      payload: { userId, roomId, timestamp: ts, reason } as any,
    }
    this.broadcastMessage(msg)
  }

  // Versioned sync helpers
  hostSendSnapshot(toPeerId: string, payload: StateSnapshotPayload) {
    const metaRoom = this.currentRoomId || payload.meta.roomId
    const fromId = this.getMyId() || ''
    const ts = Date.now()
    const msg: PeerMessage = {
      type: 'state_snapshot',
      protocolVersion: PROTOCOL_VERSION,
      meta: { roomId: metaRoom, fromId, ts },
      payload,
    } as any
    this.sendMessage(toPeerId, msg)
  }

  hostBroadcastDiff(payload: StateDiffPayload) {
    const metaRoom = this.currentRoomId || payload.meta.roomId
    const fromId = this.getMyId() || ''
    const ts = Date.now()
    const msg: PeerMessage = {
      type: 'state_diff',
      protocolVersion: PROTOCOL_VERSION,
      meta: { roomId: metaRoom, fromId, ts },
      payload,
    } as any
    this.broadcastMessage(msg)
  }

  guardRoom(meta?: MessageMeta): boolean {
    if (!meta) return true
    if (this.currentRoomId && meta.roomId && meta.roomId !== this.currentRoomId) {
      return false
    }
    return true
  }

  onStateAck(handler: (payload: StateAckPayload, fromId: string) => void) {
    this.onMessage('state_ack', (m, from) => {
      if (!this.guardRoom(m.meta)) return
      handler((m as any).payload as StateAckPayload, from || '')
    })
  }

  onResyncRequest(handler: (payload: ResyncRequestPayload, fromId: string) => void) {
    this.onMessage('resync_request', (m, from) => {
      if (!this.guardRoom(m.meta)) return
      handler((m as any).payload as ResyncRequestPayload, from || '')
    })
  }

  disconnect() {
    if (!this.me) return
    // stop heartbeat
    if (this.me.heartbeatInterval) {
      clearInterval(this.me.heartbeatInterval)
      this.me.heartbeatInterval = null
    }
    // close all pseudo connections
    this.me.connections.clear()
    // leave room
    const bus = GLOBAL.__mockPeerBus
    if (this.me.roomId) {
      const room = bus.rooms.get(this.me.roomId)
      if (room) room.peers.delete(this.me.id)
    }
    // reset flags
    this.isHostRole = false
    this.currentRoomId = null
    this.me.roomId = null
    this.me.inboxHandlers.clear()
  }
}

export const peerService = new MockPeerService()
