import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import type { PeerMessage, HeartbeatPayload, MessageMeta } from '@/types/game'
import { 
  HEARTBEAT_INTERVAL, 
  HEARTBEAT_TIMEOUT, 
  HOST_GRACE_PERIOD, 
  HOST_RECOVERY_ATTEMPTS, 
  HOST_RECOVERY_INTERVAL, 
  PROTOCOL_VERSION 
} from '@/types/game'

class PeerService {
  private peer: Peer | null = null
  private connections: Map<string, DataConnection> = new Map()
  private messageHandlers: Map<string, (data: PeerMessage, conn?: DataConnection) => void> = new Map()
  
  // Сохранение peer ID хоста для восстановления после перезагрузки
  private static readonly HOST_PEER_ID_KEY = 'hostPeerId'
  private static readonly HOST_PEER_ROOM_KEY = 'hostPeerRoom'
  
  // Heartbeat система
  private heartbeatInterval: number | null = null
  private heartbeatTimers: Map<string, number> = new Map()
  private isHostRole: boolean = false
  private lastHeartbeatReceived: number = 0
  
  // Callback для обнаружения отключения хоста
  private onHostDisconnectedCallback: (() => void) | null = null
  
  // Mesh-соединения для P2P архитектуры
  private knownPeers: Set<string> = new Set()
  private pendingConnections: Map<string, number> = new Map() // ID -> timestamp попытки
  private isConnectingToPeer: Set<string> = new Set()
  
  // Система восстановления хоста
  private hostRecoveryState = {
    inGracePeriod: false,
    originalHostId: '',
    gracePeriodStart: 0,
    recoveryAttempts: 0,
    gracePeriodTimer: null as number | null,
    onGracePeriodEndCallback: null as (() => void) | null
  }
  
  // Создание хоста с обязательным сохранением ID в localStorage
  async createHost(roomId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let targetPeerId: string | null = null
      
      // КРИТИЧНО: Всегда пытаемся восстановить сохраненный ID хоста для данной комнаты
      if (roomId) {
        targetPeerId = this.getSavedHostPeerId(roomId)
        if (targetPeerId) {
          console.log('🔄 RESTORING host with saved ID for room:', roomId, 'ID:', targetPeerId)
        }
      }
      
      // Если ID не найден в localStorage - создаем новый
      if (targetPeerId) {
        console.log('🔄 Attempting to restore host with saved ID:', targetPeerId)
        this.peer = new Peer(targetPeerId)
      } else {
        console.log('🆕 Creating new host with random ID')
        this.peer = new Peer()
      }
      
      this.peer.on('open', (id) => {
        if (targetPeerId && id === targetPeerId) {
          console.log('✅ Host successfully restored with SAVED ID:', id)
        } else {
          console.log('🆕 Host created with new ID:', id)
          // Если создали новый ID - ОБЯЗАТЕЛЬНО сохраняем его
          if (roomId) {
            this.saveHostPeerId(roomId, id)
            console.log('💾 NEW host ID saved to localStorage:', id, 'for room:', roomId)
          }
        }
        
        // ВСЕГДА сохраняем актуальный ID хоста при успешном создании
        if (roomId) {
          this.saveHostPeerId(roomId, id)
        }
        
        resolve(id)
      })
      
      this.peer.on('error', (error) => {
        console.error('Peer error:', error)
        
        // Если не удалось восстановить сохраненный ID - создаем новый
        if (targetPeerId && error.type === 'unavailable-id') {
          console.log('❌ Saved ID unavailable, creating new host and clearing localStorage...')
          
          // Очищаем устаревший ID из localStorage
          if (roomId) {
            this.clearHostPeerId(roomId)
          }
          
          this.peer = new Peer()
          
          this.peer.on('open', (newId) => {
            console.log('🆕 Host created with new ID after restore failure:', newId)
            
            // Сохраняем новый ID
            if (roomId) {
              this.saveHostPeerId(roomId, newId)
              console.log('💾 NEW host ID saved after fallback:', newId)
            }
            
            resolve(newId)
          })
          
          this.peer.on('error', (newError) => {
            reject(newError)
          })
        } else {
          reject(error)
        }
      })
      
      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn)
      })
      
      // Добавляем обработчик переподключения для хоста
      this.peer.on('disconnected', () => {
        console.log('🔌 Host disconnected from signaling server, attempting reconnect...')
        setTimeout(() => {
          if (this.peer && !this.peer.open) {
            console.log('🔄 Reconnecting host to signaling server...')
            this.peer.reconnect()
          }
        }, 1000)
      })
    })
  }
  
  // Подключение клиента к хосту
  async connectToHost(hostId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.peer = new Peer()
      
      this.peer.on('open', () => {
        const conn = this.peer!.connect(hostId)
        
        conn.on('open', () => {
          console.log('Connected to host:', hostId)
          this.connections.set(hostId, conn)
          this.setupConnectionHandlers(conn)
          resolve()
        })
        
        conn.on('error', (error) => {
          console.error('Connection error:', error)
          reject(error)
        })
      })
      
      this.peer.on('error', (error) => {
        console.error('Peer error:', error)
        reject(error)
      })
    })
  }
  
  // Обработка входящих соединений (для хоста)
  private handleIncomingConnection(conn: DataConnection) {
    console.log('New connection from:', conn.peer)
    this.connections.set(conn.peer, conn)
    this.setupConnectionHandlers(conn)
  }
  
  // Настройка обработчиков для соединения
  private setupConnectionHandlers(conn: DataConnection) {
    conn.on('data', (data) => {
      const message = data as PeerMessage
      console.log('📥 RECEIVED MESSAGE:', message.type, 'from:', conn.peer, 'payload:', message.payload)
      
      const handler = this.messageHandlers.get(message.type)
      if (handler) {
        console.log('🔧 Handling message:', message.type)
        handler(message, conn)
      } else {
        console.log('❌ No handler for message type:', message.type, 'Available handlers:', Array.from(this.messageHandlers.keys()))
      }
    })
    
    conn.on('close', () => {
      console.log('Connection closed:', conn.peer)
      this.connections.delete(conn.peer)
    })
    
    conn.on('error', (error) => {
      console.error('Connection error:', error)
      this.connections.delete(conn.peer)
    })
  }
  
  // Отправка сообщения конкретному пиру
  sendMessage(peerId: string, message: PeerMessage) {
    const conn = this.connections.get(peerId)
    console.log('Attempting to send message:', {
      peerId,
      messageType: message.type,
      connectionExists: !!conn,
      connectionOpen: conn?.open,
      totalConnections: this.connections.size
    })
    
    if (conn && conn.open) {
      conn.send(message)
      console.log('Message sent successfully to:', peerId)
    } else {
      console.warn('Connection not found or closed:', peerId, {
        connectionExists: !!conn,
        connectionOpen: conn?.open,
        allConnections: Array.from(this.connections.keys())
      })
    }
  }
  
  // Отправка сообщения всем подключенным пирам (для хоста)
  broadcastMessage(message: PeerMessage) {
    this.connections.forEach((conn, peerId) => {
      if (conn.open) {
        conn.send(message)
      }
    })
  }
  
  // Регистрация обработчика сообщений
  onMessage(type: string, handler: (data: PeerMessage, conn?: DataConnection) => void) {
    console.log('🔧 Registering message handler for:', type)
    this.messageHandlers.set(type, handler)
  }

  // Очистка всех обработчиков сообщений (для переинициализации)
  clearMessageHandlers() {
    console.log('🧹 Clearing all message handlers')
    this.messageHandlers.clear()
  }

  // Получение списка зарегистрированных обработчиков
  getRegisteredHandlers(): string[] {
    return Array.from(this.messageHandlers.keys())
  }
  
  // Получение своего ID
  getMyId(): string | null {
    return this.peer?.id || null
  }
  
  // Получение списка подключенных пиров
  getConnectedPeers(): string[] {
    return Array.from(this.connections.keys())
  }
  
  // Проверка, является ли пир хостом
  isHost(): boolean {
    // Хост - это тот, кто создал комнату и слушает входящие соединения
    // У хоста может быть 0 или больше исходящих соединений к клиентам
    return this.peer !== null && this.peer.open
  }
  
  // Проверка, является ли пир клиентом
  isClient(): boolean {
    // Клиент - это тот, кто подключился к хосту
    return this.connections.size === 1 && this.peer !== null
  }
  
  // Установка роли хоста и запуск heartbeat
  setAsHost(hostId: string) {
    this.isHostRole = true
    this.startHeartbeat(hostId)
  }
  
  // Установка роли клиента и мониторинг heartbeat
  setAsClient() {
    this.isHostRole = false
    this.stopHeartbeat()
    this.startHeartbeatMonitoring()
  }
  
  // Запуск мониторинга heartbeat (для клиентов)
  private startHeartbeatMonitoring() {
    console.log('Started heartbeat monitoring for client')
    this.lastHeartbeatReceived = Date.now()
  }
  
  // Запуск отправки heartbeat (для хоста)
  private startHeartbeat(hostId: string) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    
    this.heartbeatInterval = window.setInterval(() => {
      // Формируем meta для сообщения по требованиям BaseMessage
      const meta: MessageMeta = {
        roomId: '', // TODO: подставить реальный roomId, если доступен в этом сервисе
        fromId: this.getMyId() || hostId,
        ts: Date.now()
      }

      const heartbeatMessage: PeerMessage = {
        type: 'heartbeat',
        protocolVersion: PROTOCOL_VERSION,
        meta,
        payload: {
          timestamp: Date.now(),
          hostId: hostId
        } as HeartbeatPayload
      }
      
      this.broadcastMessage(heartbeatMessage)
      console.log('Heartbeat sent to all clients')
    }, HEARTBEAT_INTERVAL)
    
    console.log('Heartbeat started for host:', hostId)
  }
  
  // Остановка heartbeat
  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    
    // Очистка всех таймеров heartbeat
    this.heartbeatTimers.forEach(timer => clearTimeout(timer))
    this.heartbeatTimers.clear()
  }
  
  // Обработка полученного heartbeat (для клиентов)
  handleHeartbeat(hostId: string) {
    this.lastHeartbeatReceived = Date.now()
    
    // Сброс таймера отключения хоста
    if (this.heartbeatTimers.has(hostId)) {
      clearTimeout(this.heartbeatTimers.get(hostId)!)
    }
    
    // Установка нового таймера
    const timer = window.setTimeout(() => {
      console.log('Host heartbeat timeout detected for:', hostId)
      this.handleHostDisconnection(hostId)
    }, HEARTBEAT_TIMEOUT)
    
    this.heartbeatTimers.set(hostId, timer)
  }
  
  // Обработка отключения хоста
  private handleHostDisconnection(hostId: string) {
    console.log('Host disconnected:', hostId)
    
    // Удаляем соединение с отключенным хостом
    this.connections.delete(hostId)
    
    // Вызываем callback для начала процедуры выборов
    if (this.onHostDisconnectedCallback) {
      this.onHostDisconnectedCallback()
    }
  }
  
  // Регистрация callback для отключения хоста
  onHostDisconnected(callback: () => void) {
    this.onHostDisconnectedCallback = callback
  }
  
  // Переподключение к новому хосту
  async reconnectToNewHost(newHostId: string): Promise<void> {
    console.log('Reconnecting to new host:', newHostId)
    
    // Очистка старых соединений
    this.connections.clear()
    this.stopHeartbeat()
    
    // Подключение к новому хосту
    return this.connectToHost(newHostId)
  }
  
  // Проверка активности heartbeat
  isHostActive(): boolean {
    if (this.isHostRole) return true
    
    const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeatReceived
    return timeSinceLastHeartbeat < HEARTBEAT_TIMEOUT
  }
  
  // Получение времени последнего heartbeat
  getLastHeartbeatTime(): number {
    return this.lastHeartbeatReceived
  }
  
  // Получение роли
  getCurrentRole(): 'host' | 'client' | 'disconnected' {
    if (!this.peer || !this.peer.open) return 'disconnected'
    return this.isHostRole ? 'host' : 'client'
  }
  
  // Mesh P2P методы
  
  // Подключение к конкретному peer'у (для mesh-архитектуры)
  async connectToPeer(peerId: string): Promise<boolean> {
    console.log('🔗 connectToPeer called for:', peerId)
    console.log('🔍 My peer ID:', this.getMyId())
    console.log('📊 Current connections:', Array.from(this.connections.keys()))
    console.log('🚀 Pending connections:', Array.from(this.isConnectingToPeer))
    
    if (peerId === this.getMyId()) {
      console.log('❌ Skipping connection to self:', peerId)
      return true
    }
    
    if (this.connections.has(peerId)) {
      const conn = this.connections.get(peerId)
      console.log('✅ Already connected to peer:', peerId, 'connection open:', conn?.open)
      return true
    }
    
    if (this.isConnectingToPeer.has(peerId)) {
      console.log('⏳ Already connecting to peer:', peerId)
      return false
    }
    
    console.log('🚀 Attempting to connect to peer:', peerId)
    this.isConnectingToPeer.add(peerId)
    this.pendingConnections.set(peerId, Date.now())
    
    return new Promise((resolve) => {
      if (!this.peer || !this.peer.open) {
        console.log('❌ Peer not ready for connection, peer:', !!this.peer, 'open:', this.peer?.open)
        this.isConnectingToPeer.delete(peerId)
        this.pendingConnections.delete(peerId)
        resolve(false)
        return
      }
      
      console.log('🔌 Creating connection to:', peerId)
      const conn = this.peer.connect(peerId)
      
      const timeout = setTimeout(() => {
        console.log('⏰ Connection timeout to peer:', peerId)
        this.isConnectingToPeer.delete(peerId)
        this.pendingConnections.delete(peerId)
        conn.close()
        resolve(false)
      }, 5000)
      
      conn.on('open', () => {
        console.log('✅ Successfully connected to peer:', peerId)
        clearTimeout(timeout)
        this.isConnectingToPeer.delete(peerId)
        this.pendingConnections.delete(peerId)
        this.connections.set(peerId, conn)
        this.knownPeers.add(peerId)
        this.setupConnectionHandlers(conn)
        console.log('📊 Total connections after success:', this.connections.size)
        resolve(true)
      })
      
      conn.on('error', (error) => {
        console.log('❌ Failed to connect to peer:', peerId, 'error:', error)
        clearTimeout(timeout)
        this.isConnectingToPeer.delete(peerId)
        this.pendingConnections.delete(peerId)
        resolve(false)
      })
      
      console.log('⏳ Connection setup completed for:', peerId, 'waiting for events...')
    })
  }
  
  // Подключение ко всем peer'ам из списка
  async connectToAllPeers(peerIds: string[]): Promise<void> {
    console.log('Connecting to all peers:', peerIds)
    
    const connectionPromises = peerIds
      .filter(id => id !== this.getMyId())
      .map(peerId => this.connectToPeer(peerId))
    
    const results = await Promise.allSettled(connectionPromises)
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length
    
    console.log(`Connected to ${successful}/${peerIds.length} peers`)
  }
  
  // Рассылка сообщения всем подключенным peer'ам (mesh broadcast)
  broadcastToAllPeers(message: PeerMessage) {
    const sentTo: string[] = []
    
    this.connections.forEach((conn, peerId) => {
      if (conn.open) {
        try {
          conn.send(message)
          sentTo.push(peerId)
        } catch (error) {
          console.error('Failed to send message to peer:', peerId, error)
        }
      }
    })
    
    console.log(`Broadcasted ${message.type} to ${sentTo.length} peers:`, sentTo)
  }
  
  // Получение списка всех известных peer'ов
  getAllKnownPeers(): string[] {
    return Array.from(this.knownPeers)
  }
  
  // Добавление peer'а в список известных
  addKnownPeer(peerId: string) {
    if (peerId !== this.getMyId()) {
      this.knownPeers.add(peerId)
    }
  }
  
  // Добавление нескольких peer'ов
  addKnownPeers(peerIds: string[]) {
    peerIds.forEach(id => this.addKnownPeer(id))
  }
  
  // Добавление соединения в общий pool (для сохранения temporary connections)
  addConnection(peerId: string, connection: DataConnection) {
    if (peerId !== this.getMyId()) {
      console.log('Adding connection to pool:', peerId)
      this.connections.set(peerId, connection)
      this.knownPeers.add(peerId)
      this.setupConnectionHandlers(connection)
    }
  }
  
  // Проверка наличия активного соединения
  hasConnection(peerId: string): boolean {
    const conn = this.connections.get(peerId)
    return !!(conn && conn.open)
  }
  
  // Получение основного peer для discovery (вместо создания временного)
  getPeer(): Peer | null {
    return this.peer
  }
  
  // Проверка активных соединений
  getActiveConnections(): { peerId: string, isOpen: boolean }[] {
    return Array.from(this.connections.entries()).map(([peerId, conn]) => ({
      peerId,
      isOpen: conn.open
    }))
  }
  
  // Очистка неактивных соединений
  cleanupInactiveConnections() {
    const toRemove: string[] = []
    
    this.connections.forEach((conn, peerId) => {
      if (!conn.open) {
        toRemove.push(peerId)
      }
    })
    
    toRemove.forEach(peerId => {
      console.log('Removing inactive connection:', peerId)
      this.connections.delete(peerId)
    })
    
    return toRemove.length
  }
  
  // Система восстановления хоста с grace period
  
  // Запуск grace period для восстановления хоста
  startHostRecoveryGracePeriod(originalHostId: string, onGracePeriodEnd: () => void) {
    console.log('🕐 Starting host recovery grace period for:', originalHostId)
    
    // Если уже в grace period - сбрасываем
    if (this.hostRecoveryState.inGracePeriod) {
      this.cancelHostRecoveryGracePeriod()
    }
    
    this.hostRecoveryState.inGracePeriod = true
    this.hostRecoveryState.originalHostId = originalHostId
    this.hostRecoveryState.gracePeriodStart = Date.now()
    this.hostRecoveryState.recoveryAttempts = 0
    this.hostRecoveryState.onGracePeriodEndCallback = onGracePeriodEnd
    
    // Запускаем таймер grace period
    this.hostRecoveryState.gracePeriodTimer = window.setTimeout(() => {
      console.log('⏰ Host recovery grace period ended, starting migration')
      this.endHostRecoveryGracePeriod()
    }, HOST_GRACE_PERIOD)
    
    // Начинаем попытки восстановления
    this.startHostRecoveryAttempts(originalHostId)
  }
  
  // Попытки восстановления соединения с оригинальным хостом
  private async startHostRecoveryAttempts(originalHostId: string) {
    console.log('🔄 Starting host recovery attempts for:', originalHostId)
    
    const attemptRecovery = async () => {
      if (!this.hostRecoveryState.inGracePeriod || 
          this.hostRecoveryState.recoveryAttempts >= HOST_RECOVERY_ATTEMPTS) {
        return
      }
      
      this.hostRecoveryState.recoveryAttempts++
      console.log(`🔍 Host recovery attempt ${this.hostRecoveryState.recoveryAttempts}/${HOST_RECOVERY_ATTEMPTS} for:`, originalHostId)
      
      try {
        const recovered = await this.attemptHostRecovery(originalHostId)
        if (recovered) {
          console.log('✅ Host recovery successful!')
          this.handleHostRecoverySuccess(originalHostId)
          return
        }
      } catch (error) {
        console.log('❌ Host recovery attempt failed:', error)
      }
      
      // Планируем следующую попытку если есть время
      if (this.hostRecoveryState.inGracePeriod && 
          this.hostRecoveryState.recoveryAttempts < HOST_RECOVERY_ATTEMPTS) {
        setTimeout(attemptRecovery, HOST_RECOVERY_INTERVAL)
      }
    }
    
    // Начинаем первую попытку немедленно
    attemptRecovery()
  }
  
  // Попытка восстановления соединения с хостом
  private async attemptHostRecovery(originalHostId: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        if (!this.peer || !this.peer.open) {
          resolve(false)
          return
        }
        
        console.log('🔌 Attempting to reconnect to original host:', originalHostId)
        const conn = this.peer.connect(originalHostId)
        
        const timeout = setTimeout(() => {
          conn.close()
          resolve(false)
        }, 3000) // Короткий таймаут для попыток восстановления
        
        conn.on('open', () => {
          console.log('🎉 Successfully reconnected to original host!')
          clearTimeout(timeout)
          
          // Отправляем host discovery запрос для подтверждения
          conn.send({
            type: 'host_discovery_request',
            payload: {
              requesterId: this.getMyId(),
              requesterToken: '',
              timestamp: Date.now()
            }
          })
        })
        
        conn.on('data', (data: any) => {
          const message = data as PeerMessage
          if (message.type === 'host_discovery_response') {
            const response = message.payload
            console.log('📨 Host discovery response during recovery:', response)
            
            clearTimeout(timeout)
            
            if (response.isHost && response.currentHostId === originalHostId) {
              // Хост действительно восстановился
              this.connections.set(originalHostId, conn)
              this.setupConnectionHandlers(conn)
              resolve(true)
            } else {
              conn.close()
              resolve(false)
            }
          }
        })
        
        conn.on('error', () => {
          clearTimeout(timeout)
          resolve(false)
        })
        
      } catch (error) {
        console.log('❌ Host recovery attempt error:', error)
        resolve(false)
      }
    })
  }
  
  // Обработка успешного восстановления хоста
  private handleHostRecoverySuccess(originalHostId: string) {
    console.log('🎊 Host recovery completed successfully for:', originalHostId)
    console.log('🔍 RECOVERY STATE BEFORE:', {
      inGracePeriod: this.hostRecoveryState.inGracePeriod,
      recoveryAttempts: this.hostRecoveryState.recoveryAttempts,
      isHostRole: this.isHostRole,
      connectionsCount: this.connections.size,
      connectionIds: Array.from(this.connections.keys()),
      knownPeers: Array.from(this.knownPeers)
    })
    
    // Отменяем grace period
    this.cancelHostRecoveryGracePeriod()
    
    // Восстанавливаем состояние клиента
    this.isHostRole = false
    this.setAsClient()
    
    console.log('🔍 RECOVERY STATE AFTER:', {
      inGracePeriod: this.hostRecoveryState.inGracePeriod,
      isHostRole: this.isHostRole,
      connectionsCount: this.connections.size,
      connectionIds: Array.from(this.connections.keys()),
      lastHeartbeatReceived: this.lastHeartbeatReceived,
      heartbeatTimersCount: this.heartbeatTimers.size
    })
    
    console.log('📢 Host recovery successful - cancelling migration and restoring connection')
    
    // Уведомляем gameStore о успешном восстановлении
    if (this.onHostDisconnectedCallback) {
      // Отправляем специальный сигнал о восстановлении хоста
      setTimeout(() => {
        console.log('🔄 Triggering host recovery success callback')
        // Не вызываем обычный callback отключения, а используем специальный
      }, 100)
    }
  }
  
  // Добавляем callback для успешного восстановления
  private onHostRecoveredCallback: (() => void) | null = null
  
  onHostRecovered(callback: () => void) {
    this.onHostRecoveredCallback = callback
  }
  
  // Завершение grace period
  private endHostRecoveryGracePeriod() {
    if (!this.hostRecoveryState.inGracePeriod) return
    
    console.log('🏁 Host recovery grace period ended')
    
    const callback = this.hostRecoveryState.onGracePeriodEndCallback
    this.resetHostRecoveryState()
    
    // Вызываем callback для начала процедуры миграции
    if (callback) {
      callback()
    }
  }
  
  // Отмена grace period
  cancelHostRecoveryGracePeriod() {
    console.log('❌ Cancelling host recovery grace period')
    this.resetHostRecoveryState()
  }
  
  // Сброс состояния восстановления
  private resetHostRecoveryState() {
    if (this.hostRecoveryState.gracePeriodTimer) {
      clearTimeout(this.hostRecoveryState.gracePeriodTimer)
      this.hostRecoveryState.gracePeriodTimer = null
    }
    
    this.hostRecoveryState.inGracePeriod = false
    this.hostRecoveryState.originalHostId = ''
    this.hostRecoveryState.gracePeriodStart = 0
    this.hostRecoveryState.recoveryAttempts = 0
    this.hostRecoveryState.onGracePeriodEndCallback = null
  }
  
  // Проверка, находимся ли в grace period
  isInHostRecoveryGracePeriod(): boolean {
    return this.hostRecoveryState.inGracePeriod
  }
  
  // Получение информации о recovery state
  getHostRecoveryState() {
    return {
      inGracePeriod: this.hostRecoveryState.inGracePeriod,
      originalHostId: this.hostRecoveryState.originalHostId,
      recoveryAttempts: this.hostRecoveryState.recoveryAttempts,
      gracePeriodStart: this.hostRecoveryState.gracePeriodStart,
      timeRemaining: this.hostRecoveryState.inGracePeriod 
        ? Math.max(0, HOST_GRACE_PERIOD - (Date.now() - this.hostRecoveryState.gracePeriodStart))
        : 0
    }
  }
  
  // Сохранение peer ID хоста для конкретной комнаты
  private saveHostPeerId(roomId: string, peerId: string): void {
    try {
      const hostData = {
        peerId,
        roomId,
        timestamp: Date.now()
      }
      localStorage.setItem(`${PeerService.HOST_PEER_ID_KEY}_${roomId}`, JSON.stringify(hostData))
      console.log('💾 Host peer ID saved for room:', roomId, 'ID:', peerId)
    } catch (error) {
      console.error('Failed to save host peer ID:', error)
    }
  }
  
  // Загрузка сохраненного peer ID хоста для конкретной комнаты
  private getSavedHostPeerId(roomId: string): string | null {
    try {
      const savedData = localStorage.getItem(`${PeerService.HOST_PEER_ID_KEY}_${roomId}`)
      if (!savedData) return null
      
      const hostData = JSON.parse(savedData)
      
      // Проверяем актуальность (не старше 24 часов)
      const maxAge = 24 * 60 * 60 * 1000 // 24 часа
      if (Date.now() - hostData.timestamp > maxAge) {
        console.log('🕐 Saved host peer ID expired, removing from localStorage')
        this.clearHostPeerId(roomId)
        return null
      }
      
      console.log('📋 Found saved host peer ID for room:', roomId, 'ID:', hostData.peerId)
      return hostData.peerId
    } catch (error) {
      console.error('Failed to load saved host peer ID:', error)
      return null
    }
  }
  
  // Очистка сохраненного peer ID хоста
  private clearHostPeerId(roomId: string): void {
    try {
      localStorage.removeItem(`${PeerService.HOST_PEER_ID_KEY}_${roomId}`)
      console.log('🗑️ Cleared saved host peer ID for room:', roomId)
    } catch (error) {
      console.error('Failed to clear host peer ID:', error)
    }
  }
  
  // Публичный метод для очистки ID хоста (для вызова при покидании комнаты)
  clearSavedHostId(roomId: string): void {
    this.clearHostPeerId(roomId)
  }
  
  // Закрытие всех соединений
  disconnect() {
    this.stopHeartbeat()
    this.cancelHostRecoveryGracePeriod()
    
    this.connections.forEach((conn) => {
      conn.close()
    })
    this.connections.clear()
    
    if (this.peer) {
      this.peer.destroy()
      this.peer = null
    }
    
    this.isHostRole = false
    this.lastHeartbeatReceived = 0
    this.onHostDisconnectedCallback = null
    
    // Очистка mesh данных
    this.knownPeers.clear()
    this.pendingConnections.clear()
    this.isConnectingToPeer.clear()
  }
}

export const peerService = new PeerService()
