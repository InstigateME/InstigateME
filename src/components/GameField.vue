<template>
  <div class="game-field">
    <div class="container">
      <div class="header">
        <h1 class="title">P2P Light-Up</h1>
        <button class="leave-btn" @click="leaveGame">
          Покинуть игру
        </button>
      </div>
      
      <div class="game-info">
        <p class="players-count">Игроков: {{ gameStore.gameState.players.length }}</p>
        <div class="status-info">
          <div class="connection-status" :class="connectionStatusClass">
            {{ connectionStatusText }}
          </div>
          <div v-if="gameStore.gameState.roomId" class="room-code">
            Код комнаты: <strong>{{ gameStore.gameState.roomId }}</strong>
          </div>
        </div>
        <p class="instruction">Нажмите кнопку "Подсветить меня", чтобы подсветить свой квадрат</p>
      </div>
      
      <!-- Игровая сетка -->
      <div class="game-grid">
        <div 
          v-for="player in gameStore.gameState.players" 
          :key="player.id"
          class="player-square"
          :class="{ 
            'lit-up': gameStore.gameState.litUpPlayerId === player.id,
            'my-square': player.id === gameStore.myPlayerId 
          }"
          :style="{ 
            backgroundColor: player.color,
            borderColor: player.color 
          }"
        >
          <div class="player-info">
            <div class="player-nickname">{{ player.nickname }}</div>
            <div class="player-id">{{ player.id.substring(0, 8) }}...</div>
            <div v-if="player.isHost" class="host-indicator">👑</div>
          </div>
          
          <!-- Эффект подсветки -->
          <div v-if="gameStore.gameState.litUpPlayerId === player.id" class="light-effect"></div>
        </div>
      </div>
      
      <!-- Кнопка управления -->
      <div class="control-section">
        <button 
          class="light-up-btn"
          @click="lightUp"
          :disabled="gameStore.gameState.litUpPlayerId !== null"
          :class="{ 'pulsing': gameStore.gameState.litUpPlayerId === gameStore.myPlayerId }"
        >
          {{ buttonText }}
        </button>
      </div>
      
      <!-- Информация о текущем действии -->
      <div v-if="gameStore.gameState.litUpPlayerId" class="action-info">
        <p>
          <strong>{{ getLitUpPlayerName() }}</strong> подсвечивается!
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/gameStore'

const router = useRouter()
const gameStore = useGameStore()

// Computed свойства
const buttonText = computed(() => {
  if (gameStore.gameState.litUpPlayerId === gameStore.myPlayerId) {
    return 'Подсвечиваюсь...'
  } else if (gameStore.gameState.litUpPlayerId) {
    return 'Кто-то подсвечивается...'
  } else {
    return 'Подсветить меня'
  }
})

const connectionStatusText = computed(() => {
  switch (gameStore.connectionStatus) {
    case 'connected':
      return gameStore.isHost ? '🟢 Хост активен' : '🟢 Подключен к хосту'
    case 'connecting':
      return '🟡 Переподключение...'
    case 'disconnected':
      return '🔴 Отключен'
    default:
      return '❓ Неизвестно'
  }
})

const connectionStatusClass = computed(() => {
  switch (gameStore.connectionStatus) {
    case 'connected':
      return 'status-connected'
    case 'connecting':
      return 'status-connecting'
    case 'disconnected':
      return 'status-disconnected'
    default:
      return 'status-unknown'
  }
})

// Методы
const lightUp = () => {
  if (gameStore.gameState.litUpPlayerId !== null) return
  gameStore.lightUpPlayer()
}

const getLitUpPlayerName = () => {
  if (!gameStore.gameState.litUpPlayerId) return ''
  
  const player = gameStore.gameState.players.find(p => p.id === gameStore.gameState.litUpPlayerId)
  
  // Если игрок не найден, очищаем litUpPlayerId для предотвращения повторных ошибок
  if (!player) {
    console.log('Player not found for litUpPlayerId, clearing it:', gameStore.gameState.litUpPlayerId)
    gameStore.gameState.litUpPlayerId = null
    return ''
  }
  
  return player.nickname || 'Игрок'
}

const leaveGame = () => {
  gameStore.leaveRoom()
  router.push('/')
}

onMounted(() => {
  // Проверяем, что игра началась
  if (!gameStore.gameState.gameStarted || !gameStore.myPlayerId) {
    router.push('/')
    return
  }
})
</script>

<style scoped>
.game-field {
  min-height: 100vh;
  background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
  padding: 20px;
}

.container {
  max-width: 1000px;
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
  margin-bottom: 20px;
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
  padding: 12px 24px;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.leave-btn:hover {
  background: #c0392b;
  transform: translateY(-2px);
}

.game-info {
  text-align: center;
  margin-bottom: 30px;
  padding: 20px;
  background: #f8f9fa;
  border-radius: 15px;
}

.players-count {
  font-size: 1.2rem;
  font-weight: 600;
  color: #333;
  margin-bottom: 10px;
}

.status-info {
  margin: 15px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.connection-status {
  padding: 8px 16px;
  border-radius: 20px;
  font-weight: 600;
  font-size: 0.9rem;
}

.status-connected {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.status-connecting {
  background: #fff3cd;
  color: #856404;
  border: 1px solid #ffeaa7;
}

.status-disconnected {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.status-unknown {
  background: #e2e3e5;
  color: #383d41;
  border: 1px solid #d6d8db;
}

.room-code {
  font-size: 0.9rem;
  color: #666;
}

.room-code strong {
  color: #333;
  font-family: monospace;
}

.instruction {
  color: #666;
  font-size: 1rem;
  margin: 0;
}

.game-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
  margin-bottom: 40px;
  padding: 20px;
}

.player-square {
  position: relative;
  aspect-ratio: 1;
  border-radius: 20px;
  border: 4px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  cursor: default;
  overflow: hidden;
}

.player-square.my-square {
  box-shadow: 0 0 20px rgba(0, 123, 255, 0.5);
  border-width: 6px;
}

.player-square.lit-up {
  animation: lightUp 0.5s ease-in-out;
  transform: scale(1.05);
  box-shadow: 0 0 30px currentColor, 0 0 60px currentColor;
  z-index: 10;
}

@keyframes lightUp {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.1);
  }
}

.player-info {
  text-align: center;
  color: white;
  z-index: 2;
  position: relative;
}

.player-nickname {
  font-size: 1.4rem;
  font-weight: bold;
  margin-bottom: 8px;
  text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
}

.player-id {
  font-family: monospace;
  font-size: 0.9rem;
  opacity: 0.8;
  margin-bottom: 8px;
}

.host-indicator {
  font-size: 1.5rem;
  margin-top: 5px;
}

.light-effect {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.3) 0%, transparent 70%);
  border-radius: inherit;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 0.3;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.02);
  }
}

.control-section {
  text-align: center;
  margin-bottom: 30px;
}

.light-up-btn {
  background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
  color: white;
  border: none;
  padding: 20px 40px;
  border-radius: 15px;
  font-size: 1.3rem;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.3s ease;
  text-transform: uppercase;
  letter-spacing: 1px;
  min-width: 250px;
}

.light-up-btn:hover:not(:disabled) {
  transform: translateY(-3px);
  box-shadow: 0 10px 25px rgba(255, 107, 107, 0.4);
}

.light-up-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.light-up-btn.pulsing {
  animation: buttonPulse 0.5s ease-in-out infinite alternate;
}

@keyframes buttonPulse {
  0% {
    transform: scale(1);
  }
  100% {
    transform: scale(1.05);
  }
}

.action-info {
  text-align: center;
  padding: 15px;
  background: linear-gradient(135deg, #74b9ff 0%, #0984e3 100%);
  color: white;
  border-radius: 12px;
  font-size: 1.1rem;
  margin-bottom: 20px;
}

.action-info p {
  margin: 0;
}

/* Адаптивность */
@media (max-width: 768px) {
  .game-grid {
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 15px;
    padding: 15px;
  }
  
  .player-square {
    border-radius: 15px;
  }
  
  .player-nickname {
    font-size: 1.2rem;
  }
  
  .light-up-btn {
    padding: 16px 32px;
    font-size: 1.1rem;
    min-width: 200px;
  }
}

@media (max-width: 480px) {
  .game-grid {
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  
  .player-square {
    border-radius: 12px;
  }
  
  .player-nickname {
    font-size: 1rem;
  }
  
  .player-id {
    font-size: 0.8rem;
  }
}
</style>
