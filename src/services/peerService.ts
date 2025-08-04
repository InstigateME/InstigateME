import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import type { PeerMessage, HeartbeatPayload } from '@/types/game'
import { HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT } from '@/types/game'

class PeerService {
  private peer: Peer | null = null
  private connections: Map<string, DataConnection> = new Map()
  private messageHandlers: Map<string, (data: PeerMessage, conn?: DataConnection) => void> = new Map()
  
  // Heartbeat система
  private heartbeatInterval: number | null = null
  private heartbeatTimers: Map<string, number> = new Map()
  private isHostRole: boolean = false
  private lastHeartbeatReceived: number = 0
  
  // Callback для обнаружения отключения хоста
  private onHostDisconnectedCallback: (() => void) | null = null
  
  // Создание хоста
  async createHost(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.peer = new Peer()
      
      this.peer.on('open', (id) => {
        console.log('Host created with ID:', id)
        resolve(id)
      })
      
      this.peer.on('error', (error) => {
        console.error('Peer error:', error)
        reject(error)
      })
      
      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn)
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
      console.log('Received message:', message)
      
      const handler = this.messageHandlers.get(message.type)
      if (handler) {
        handler(message, conn)
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
    if (conn && conn.open) {
      conn.send(message)
    } else {
      console.warn('Connection not found or closed:', peerId)
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
    this.messageHandlers.set(type, handler)
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
  }
  
  // Запуск отправки heartbeat (для хоста)
  private startHeartbeat(hostId: string) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    
    this.heartbeatInterval = window.setInterval(() => {
      const heartbeatMessage: PeerMessage = {
        type: 'heartbeat',
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
  
  // Закрытие всех соединений
  disconnect() {
    this.stopHeartbeat()
    
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
  }
}

export const peerService = new PeerService()
