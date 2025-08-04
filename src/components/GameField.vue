<template>
  <div class="game-field">
    <div class="container">
      <div class="header">
        <h1 class="title">Провокатор</h1>
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
        <p class="instruction">
          {{ phaseInstruction }}
        </p>
      </div>

      <!-- Этап: ожидание старта -->
      <div v-if="!gameStore.gameState.gameStarted" class="waiting-block">
        <p>Ожидание старта игры...</p>
        <button v-if="gameStore.isHost && gameStore.canStartGame" @click="startGame">
          Начать игру
        </button>
      </div>

      <!-- Этап: вопрос -->
      <div v-else>
        <div v-if="phase === 'question'">
          <div class="question-block">
            <h2>Вопрос</h2>
            <div class="question-card">
              {{ currentQuestion || '—' }}
            </div>
            <button v-if="isMyTurn && !currentQuestion" @click="drawCard">
              Вытянуть вопрос
            </button>
            <div v-if="currentQuestion && !voted" class="vote-section">
              <h3>Голосование</h3>
              <p>Выберите, кто подходит под описание (2 голоса):</p>
              <div class="players-list">
                <button
                  v-for="player in otherPlayers"
                  :key="player.id"
                  :disabled="voteSelection.length >= 2 && !voteSelection.includes(player.id)"
                  :class="{ selected: voteSelection.includes(player.id) }"
                  @click="toggleVote(player.id)"
                >
                  {{ player.nickname }}
                </button>
              </div>
              <button
                :disabled="voteSelection.length !== 2"
                @click="submitVote"
              >
                Проголосовать
              </button>
            </div>
            <div v-if="voted && !betPlaced" class="bet-section">
              <h3>Ставка</h3>
              <p>Как думаете, сколько голосов наберёте?</p>
              <div class="bet-cards">
                <button
                  v-for="bet in myPlayer.bettingCards"
                  :key="bet"
                  :class="{ selected: betSelection === bet }"
                  @click="selectBet(bet)"
                >
                  {{ bet }}
                </button>
              </div>
              <button :disabled="!betSelection" @click="submitBet">
                Сделать ставку
              </button>
            </div>
            <div v-if="voted && betPlaced">
              <p>Ожидание других игроков...</p>
            </div>
          </div>
        </div>

        <!-- Этап: результаты -->
        <div v-if="phase === 'results'">
          <div class="results-block">
            <h2>Результаты раунда</h2>
            <div class="votes-list">
              <div v-for="player in gameStore.gameState.players" :key="player.id">
                <strong>{{ player.nickname }}</strong> — голосов: {{ voteCounts[player.id] || 0 }}, ставка: {{ bets[player.id] || '-' }}, очки: {{ scores[player.id] || 0 }}
              </div>
            </div>
            <button v-if="isMyTurn" @click="finishRound">
              Следующий раунд
            </button>
          </div>
        </div>

        <!-- Этап: режим 2.0 -->
        <div v-if="phase === 'advanced-answer'">
          <div class="advanced-block">
            <h2>Кто будет отвечать?</h2>
            <p>Тайное голосование: выберите, кто должен отвечать на вопрос</p>
            <div class="players-list">
              <button
                v-for="player in otherPlayers"
                :key="player.id"
                :disabled="voteSelection.length >= 2 && !voteSelection.includes(player.id)"
                :class="{ selected: voteSelection.includes(player.id) }"
                @click="toggleVote(player.id)"
              >
                {{ player.nickname }}
              </button>
            </div>
            <button
              :disabled="voteSelection.length !== 2"
              @click="submitVote"
            >
              Проголосовать
            </button>
          </div>
        </div>
        <div v-if="phase === 'advanced-write'">
          <div class="advanced-block">
            <h2>Ответ игрока</h2>
            <div v-if="isAnsweringPlayer">
              <textarea v-model="answerText" placeholder="Введите ваш ответ"></textarea>
              <button :disabled="!answerText" @click="submitAnswer">Отправить ответ</button>
            </div>
            <div v-else>
              <p>Ожидание ответа игрока...</p>
            </div>
          </div>
        </div>
        <div v-if="phase === 'advanced-guess'">
          <div class="advanced-block">
            <h2>Угадай ответ</h2>
            <div v-if="!guessed">
              <textarea v-model="guessText" placeholder="Ваш вариант ответа"></textarea>
              <button :disabled="!guessText" @click="submitGuess">Отправить</button>
            </div>
            <div v-else>
              <p>Ожидание других игроков...</p>
            </div>
          </div>
        </div>
        <div v-if="phase === 'advanced-results'">
          <div class="results-block">
            <h2>Результаты раунда</h2>
            <div>
              <p>Ответ: <strong>{{ advancedAnswer }}</strong></p>
              <div v-for="player in gameStore.gameState.players" :key="player.id">
                <strong>{{ player.nickname }}</strong> — {{ guesses[player.id] || '-' }} {{ scores[player.id] ? `(+${scores[player.id]})` : '' }}
              </div>
            </div>
            <button v-if="isMyTurn" @click="finishRound">
              Следующий раунд
            </button>
          </div>
        </div>

        <!-- Таблица очков -->
        <div class="score-table">
          <h3>Таблица очков</h3>
          <table>
            <tr>
              <th>Игрок</th>
              <th>Очки</th>
            </tr>
            <tr v-for="player in gameStore.gameState.players" :key="player.id">
              <td>{{ player.nickname }}</td>
              <td>{{ scores[player.id] || 0 }}</td>
            </tr>
          </table>
          <div v-if="isGameOver" class="winner-block">
            <h2>Победитель: {{ winnerName }}</h2>
            <button @click="restartGame">Начать новую игру</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/gameStore'

const router = useRouter()
const gameStore = useGameStore()

const phase = ref<'question' | 'results' | 'advanced-answer' | 'advanced-write' | 'advanced-guess' | 'advanced-results'>('question')
const voteSelection = ref<string[]>([])
const betSelection = ref<string | null>(null)
const answerText = ref('')
const guessText = ref('')
const voted = ref(false)
const betPlaced = ref(false)
const guessed = ref(false)
const advancedAnswer = ref('')
const currentQuestion = computed(() => gameStore.gameState.currentQuestion)
const myPlayer = computed(() => gameStore.myPlayer || { bettingCards: [] })
const isMyTurn = computed(() => gameStore.gameState.players[gameStore.gameState.currentTurn]?.id === gameStore.myPlayerId)
const otherPlayers = computed(() => gameStore.gameState.players.filter(p => p.id !== gameStore.myPlayerId))
const scores = computed(() => gameStore.gameState.scores || {})
const bets = computed(() => gameStore.gameState.bets || {})
const guesses = computed(() => gameStore.gameState.guesses || {})
const voteCounts = computed(() => {
  const counts: Record<string, number> = {}
  const votes = gameStore.gameState.votes || {}
  Object.values(votes).forEach((arr: string[]) => {
    arr.forEach(id => {
      counts[id] = (counts[id] || 0) + 1
    })
  })
  return counts
})

const isAnsweringPlayer = computed(() => {
  // В режиме advanced, игрок с макс. голосов отвечает
  if (!gameStore.gameState.votes) return false
  const counts: Record<string, number> = {}
  Object.values(gameStore.gameState.votes).forEach((arr: string[]) => {
    arr.forEach(id => {
      counts[id] = (counts[id] || 0) + 1
    })
  })
  const maxVotes = Math.max(0, ...Object.values(counts))
  const leaders = Object.entries(counts).filter(([_, c]) => c === maxVotes && maxVotes > 0).map(([id]) => id)
  return leaders[0] === gameStore.myPlayerId
})

const phaseInstruction = computed(() => {
  if (!gameStore.gameState.gameStarted) return 'Ожидание старта игры...'
  if (phase.value === 'question') return 'Вытяните вопрос, проголосуйте и сделайте ставку.'
  if (phase.value === 'results') return 'Смотрите результаты раунда.'
  if (phase.value.startsWith('advanced')) return 'Режим 2.0: письменные ответы и угадывания.'
  return ''
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

function leaveGame() {
  gameStore.leaveRoom()
  router.push('/')
}

function startGame() {
  gameStore.startGame(gameStore.gameMode)
}

function drawCard() {
  gameStore.drawCard()
}

function toggleVote(id: string) {
  if (voteSelection.value.includes(id)) {
    voteSelection.value = voteSelection.value.filter(x => x !== id)
  } else if (voteSelection.value.length < 2) {
    voteSelection.value.push(id)
  }
}

function submitVote() {
  gameStore.submitVote(gameStore.myPlayerId, [...voteSelection.value])
  voted.value = true
}

function selectBet(bet: string) {
  betSelection.value = bet
}

function submitBet() {
  if (!betSelection.value) return
  gameStore.submitBet(gameStore.myPlayerId, betSelection.value)
  betPlaced.value = true
}

function finishRound() {
  gameStore.finishRound()
  resetLocal()
}

function submitAnswer() {
  gameStore.submitAnswer(gameStore.myPlayerId, answerText.value)
  advancedAnswer.value = answerText.value
}

function submitGuess() {
  gameStore.submitGuess(gameStore.myPlayerId, guessText.value)
  guessed.value = true
}

function resetLocal() {
  voteSelection.value = []
  betSelection.value = null
  answerText.value = ''
  guessText.value = ''
  voted.value = false
  betPlaced.value = false
  guessed.value = false
  advancedAnswer.value = ''
}

watch(() => gameStore.gameState.currentQuestion, (val) => {
  if (val) {
    phase.value = gameStore.gameMode === 'advanced' ? 'advanced-answer' : 'question'
    resetLocal()
  }
})

watch(() => gameStore.gameState.votes, (val) => {
  // Если все проголосовали — переход к ставкам или к следующему этапу
  const total = gameStore.gameState.players.length
  if (val && Object.keys(val).length === total) {
    if (gameStore.gameMode === 'basic') {
      phase.value = 'question'
    } else {
      // advanced: после голосования — ответ
      phase.value = 'advanced-write'
    }
  }
})

watch(() => gameStore.gameState.bets, (val) => {
  if (gameStore.gameMode === 'basic') {
    const total = gameStore.gameState.players.length
    if (val && Object.keys(val).length === total) {
      phase.value = 'results'
    }
  }
})

watch(() => gameStore.gameState.answers, (val) => {
  if (gameStore.gameMode === 'advanced' && val) {
    // После ответа — угадывания
    phase.value = 'advanced-guess'
  }
})

watch(() => gameStore.gameState.guesses, (val) => {
  if (gameStore.gameMode === 'advanced' && val) {
    const total = gameStore.gameState.players.length - 1
    if (Object.keys(val).length === total) {
      phase.value = 'advanced-results'
    }
  }
})

const MAX_ROUNDS = 10 // Можно вынести в настройки

const isGameOver = computed(() => {
  // Пример: игра завершается после N раундов или если закончились вопросы
  return gameStore.gameState.questionCards.length === 0 ||
    (gameStore.gameState.currentTurn >= MAX_ROUNDS)
})

const winnerName = computed(() => {
  const max = Math.max(...Object.values(scores.value))
  const winner = gameStore.gameState.players.find(p => scores.value[p.id] === max)
  return winner ? winner.nickname : '—'
})

function restartGame() {
  gameStore.startGame(gameStore.gameMode)
  phase.value = 'question'
}

onMounted(() => {
  if (!gameStore.gameState.gameStarted || !gameStore.myPlayerId) {
    router.push('/')
    return
  }
  if (!gameStore.gameState.currentQuestion) {
    phase.value = 'question'
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
