<template>
  <div class="lobby">
    <div class="container">
      <div class="header">
        <h1 class="title">Комната</h1>
        <button class="leave-btn" @click="leaveRoom">
          Покинуть комнату
        </button>
      </div>

      <!-- Хост секция -->
      <div v-if="gameStore.isHost" class="host-section">
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-banner">
          <span class="dot"></span>
          Восстанавливаем подключение… сохраняем состояние игры.
        </div>
        <div v-else>
        <div class="room-info">
          <div class="room-id-section">
            <h3>ID комнаты для подключения:</h3>
            <div class="room-id-display">
              <span class="room-id">{{ gameStore.gameState.hostId }}</span>
              <button class="copy-btn" @click="copyHostId">
                {{ copiedHostId ? 'Скопировано!' : 'Копировать' }}
              </button>
            </div>
            <div class="host-info">
              <small>Отправьте этот ID друзьям для подключения к комнате</small>
            </div>

            <div style="margin-top: 20px;">
              <h4>Название комнаты: {{ gameStore.gameState.roomId }}</h4>
              <small style="color: #666;">Для удобства запоминания</small>
            </div>
          </div>

          <div class="qr-section">
            <h3>QR-код для подключения:</h3>
            <div class="qr-container">
              <canvas ref="qrCanvas" class="qr-code"></canvas>
            </div>
            <div class="qr-link">
              <button class="copy-link-btn" @click="copyJoinLink" :disabled="!gameStore.gameState.roomId">
                {{ linkCopied ? 'Ссылка скопирована!' : 'Скопировать ссылку' }}
              </button>
            </div>
          </div>
        </div>

        <div class="start-section" v-if="gameStore.connectionStatus === 'connected'">
          <button
            class="btn btn-primary btn-large"
            @click="startGame"
            :disabled="!gameStore.canStartGame"
          >
            {{ gameStore.canStartGame ? 'Начать игру' : `Ожидание игроков (${gameStore.gameState.players.length}/2)` }}
          </button>
        </div>
        </div>
      </div>

      <!-- Клиент секция -->
      <div v-else class="client-section">
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-banner">
          <span class="dot"></span>
          Переподключение к хосту… сохраняем состояние игры.
        </div>
        <div v-else class="waiting-message">
          <h3>Ожидание начала игры...</h3>
          <p>Хост начнет игру, когда будет готов</p>
        </div>
      </div>

      <!-- Список игроков -->
      <div v-if="gameStore.connectionStatus === 'connecting'" class="reconnect-banner">
        <span class="dot"></span>
        Восстанавливаем подключение к хосту…
      </div>

      <div class="players-section">
        <h3>Игроки в комнате ({{ gameStore.gameState.players.length }}/{{ gameStore.gameState.maxPlayers }}):</h3>
        <div class="players-list">
          <div
            v-for="player in gameStore.gameState.players"
            :key="player.id"
            class="player-item"
            :style="{ backgroundColor: player.color + '20', borderColor: player.color }"
          >
            <div class="player-avatar" :style="{ backgroundColor: player.color }">
              {{ player.nickname[0].toUpperCase() }}
            </div>
            <div class="player-info">
              <span class="player-name">{{ player.nickname }}</span>
              <span v-if="player.isHost" class="host-badge">Хост</span>
              <span v-if="player.id === gameStore.myPlayerId" class="me-badge">Вы</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="errorMessage" class="error-message">
        {{ errorMessage }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/gameStore'
import QRCode from 'qrcode'

const router = useRouter()
const gameStore = useGameStore()

const qrCanvas = ref<HTMLCanvasElement>()
const copied = ref(false)
const copiedHostId = ref(false)
const errorMessage = ref('')
const linkCopied = ref(false)

const generateUrl = (): string =>
  `${window.location.origin}/?hostId=${encodeURIComponent(gameStore.gameState.hostId)}`

// Генерация QR-кода
const generateQRCode = async () => {
  if (!qrCanvas.value || !gameStore.gameState.hostId) return

  try {
    await QRCode.toCanvas(qrCanvas.value, generateUrl(), {
      width: 200,
      margin: 2,
      color: {
        dark: '#333333',
        light: '#ffffff'
      }
    })
  } catch (error) {
    console.error('Failed to generate QR code:', error)
  }
}

// Копирование ID комнаты
const copyRoomId = async () => {
  try {
    await navigator.clipboard.writeText(gameStore.gameState.roomId)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch (error) {
    console.error('Failed to copy room ID:', error)
  }
}

 // Копирование ID хоста
const copyHostId = async () => {
  try {
    await navigator.clipboard.writeText(gameStore.gameState.hostId)
    copiedHostId.value = true
    setTimeout(() => {
      copiedHostId.value = false
    }, 2000)
  } catch (error) {
    console.error('Failed to copy host ID:', error)
  }
}

// Копирование ссылки подключения
const copyJoinLink = async () => {
  try {
    await navigator.clipboard.writeText(generateUrl())
    linkCopied.value = true
    setTimeout(() => {
      linkCopied.value = false
    }, 2000)
  } catch (error) {
    console.error('Failed to copy join link:', error)
  }
}

// Начать игру
const startGame = () => {
  try {
    gameStore.startGame()
    router.push('/game')
  } catch (error) {
    console.error('Failed to start game:', error)
    errorMessage.value = 'Не удалось начать игру'
  }
}

// Покинуть комнату
const leaveRoom = () => {
  gameStore.leaveRoom()
  router.push('/')
}

// Отслеживание начала игры
watch(() => gameStore.gameState.gameStarted, (started) => {
  if (started && !gameStore.isHost) {
    router.push('/game')
  }
})

onMounted(() => {
  // Если идет восстановление/переподключение — пока показываем текущий экран
  if (gameStore.connectionStatus === 'connecting') {
    return
  }

  // Проверяем, что мы в комнате
  if (!gameStore.myPlayerId) {
    router.push('/')
    return
  }

  // Если игра уже не в lobby — сразу переходим в игру
  const phase = gameStore.gameState.phase ?? (gameStore.gameState.gameStarted ? 'drawing_question' : 'lobby')
  if (phase !== 'lobby' || gameStore.gameState.gameStarted) {
    router.push('/game')
    return
  }

  // Генерируем QR-код для хоста
  if (gameStore.isHost) {
    generateQRCode()
  }
})
</script>

<style scoped>
.lobby {
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 20px;
}

.container {
  max-width: 800px;
  margin: 0 auto;
  background: white;
  border-radius: 20px;
  padding: 30px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 2px solid #f0f0f0;
}

.title {
  color: #333;
  font-size: 2rem;
  font-weight: bold;
  margin: 0;
}

.leave-btn {
  background: #e74c3c;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.leave-btn:hover {
  background: #c0392b;
  transform: translateY(-2px);
}

.host-section {
  margin-bottom: 30px;
}

.room-info {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 30px;
  margin-bottom: 30px;
}

.room-id-section h3,
.qr-section h3 {
  color: #333;
  margin-bottom: 15px;
  font-size: 1.2rem;
}

.room-id-display {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.room-id {
  background: #f8f9fa;
  padding: 12px 16px;
  border-radius: 8px;
  font-family: monospace;
  font-size: 1.1rem;
  font-weight: bold;
  color: #333;
  border: 2px solid #e9ecef;
  word-break: break-all;
}

.copy-btn {
  background: #28a745;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  white-space: nowrap;
}

.copy-btn:hover {
  background: #218838;
}

.host-info {
  margin-top: 10px;
}

.host-info small {
  color: #666;
  font-size: 0.9rem;
  font-family: monospace;
}

.qr-container {
  display: flex;
  justify-content: center;
}

.qr-code {
  border-radius: 10px;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
}

.qr-link {
  margin-top: 10px;
  text-align: center;
  word-break: break-all;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.copy-link-btn {
  background: #2563eb;
  color: white;
  border: none;
  padding: 8px 14px;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.copy-link-btn:hover {
  background: #1d4ed8;
}

.copy-link-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.qr-link-hint {
  color: #3b82f6;
  font-family: monospace;
  font-size: 0.9rem;
}

.start-section {
  text-align: center;
}
.reconnect-banner {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff3cd;
  color: #7a5d00;
  border: 1px solid #ffe08a;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.reconnect-banner .dot {
  width: 8px;
  height: 8px;
  background: #f59e0b;
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
}

.client-section {
  text-align: center;
  margin-bottom: 30px;
  padding: 30px;
  background: #f8f9fa;
  border-radius: 15px;
}

.waiting-message h3 {
  color: #333;
  margin-bottom: 10px;
}

.waiting-message p {
  color: #666;
  font-size: 1rem;
}

.players-section h3 {
  color: #333;
  margin-bottom: 20px;
  font-size: 1.3rem;
}

.players-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 15px;
}

.player-item {
  display: flex;
  align-items: center;
  padding: 15px;
  border-radius: 12px;
  border: 2px solid;
  transition: transform 0.2s ease;
}

.player-item:hover {
  transform: translateY(-2px);
}

.player-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
  font-size: 1.2rem;
  margin-right: 15px;
}

.player-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.player-name {
  font-weight: 600;
  color: #333;
}

.host-badge,
.me-badge {
  font-size: 0.8rem;
  padding: 4px 8px;
  border-radius: 12px;
  font-weight: 600;
}

.host-badge {
  background: #ffd700;
  color: #333;
}

.me-badge {
  background: #17a2b8;
  color: white;
}

.btn {
  padding: 16px 32px;
  border: none;
  border-radius: 12px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  min-width: 200px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
}

.btn-large {
  padding: 18px 36px;
  font-size: 1.2rem;
}

.error-message {
  color: #e74c3c;
  text-align: center;
  margin-top: 20px;
  padding: 15px;
  background: #fdf2f2;
  border-radius: 10px;
  font-weight: 600;
}

@media (max-width: 768px) {
  .room-info {
    grid-template-columns: 1fr;
    gap: 20px;
  }

  .room-id-display {
    flex-direction: column;
    align-items: stretch;
  }

  .players-list {
    grid-template-columns: 1fr;
  }
}
</style>
