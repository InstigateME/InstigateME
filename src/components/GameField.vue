<template>
  <div class="game-field">
    <div class="container">
      <div class="header">
        <h1 class="title">Провокатор</h1>
        <button class="leave-btn" @click="leaveGame">
          Покинуть игру
        </button>
      </div>

      <!-- Верхняя панель состояния -->
      <div class="game-info">
        <p class="players-count">
          Игроков: {{ players.length }} • Мой ID: {{ myIdShort }} • {{ isHost ? 'Хост' : 'Клиент' }}
        </p>
        <div class="status-info">
          <div class="connection-status" :class="connectionStatusClass">
            {{ connectionStatusText }}
          </div>
          <div v-if="roomId" class="room-code">
            Код комнаты: <strong>{{ roomId }}</strong>
          </div>
        </div>
        <p class="instruction">
          Режим: {{ gameMode }} • Фаза: {{ phaseLabel }}
        </p>
      </div>

      <!-- Лобби -->
      <div v-if="phase === 'lobby'" class="waiting-block">
        <p>Ожидание старта игры. Подключено игроков: {{ players.length }}.</p>
        <div v-if="isHost" class="lobby-controls">
          <button :disabled="!canStartBasic" @click="startBasic">Начать (basic)</button>
          <button :disabled="!canStartBasic" @click="startAdvanced">Начать (advanced)</button>
          <small v-if="!canStartBasic">Нужно минимум 3 игрока</small>
        </div>
        <div v-else>
          <p>Ждем, пока хост начнет игру…</p>
        </div>
        <ul>
          <li v-for="p in players" :key="p.id">
            {{ p.nickname }} <span v-if="p.isHost">👑</span>
          </li>
        </ul>
      </div>

      <!-- Вытягивание вопроса -->
      <div v-else-if="phase === 'drawing_question'" class="phase-block">
        <h2>Вытягивание вопроса</h2>
        <p>Ходит: <strong>{{ currentTurnName }}</strong></p>
        <div class="question-card">{{ currentQuestion ?? '—' }}</div>
        <button
          v-if="isMyTurn"
          :disabled="!!currentQuestion"
          @click="onDrawQuestion"
        >
          Вытянуть вопрос
        </button>
        <p v-else>Ожидаем, пока {{ currentTurnName }} вытянет вопрос…</p>

        <!-- Убираем inline-голосование из drawing_question: голосование теперь отображается в фазе voting вместе с карточкой -->
      </div>

      <!-- Голосование (basic/advanced) -->
      <div v-else-if="phase === 'voting' || phase === 'secret_voting'" class="phase-block">
        <!-- Показываем карточку вопроса над голосованием, чтобы она не исчезала после вытягивания -->
        <div class="question-card" v-if="currentQuestion">{{ currentQuestion }}</div>
        <h2>{{ phase === 'voting' ? 'Голосование' : 'Тайное голосование' }}</h2>
        <p>Выберите до двух игроков</p>
        <div class="players-list">
          <button
            v-for="p in otherPlayers"
            :key="p.id"
            :disabled="isVoteDisabled(p.id)"
            :class="{ selected: selectedVotes.includes(p.id) }"
            @click="onToggleVote(p.id)"
          >
            {{ p.nickname }}
          </button>
        </div>
        <button
          :disabled="selectedVotes.length === 0 || selectedVotes.length > 2 || alreadyVoted"
          @click="onSendVote"
        >
          Проголосовать ({{ selectedVotes.length }}/2)
        </button>
      </div>

      <!-- Ставки (basic) -->
      <div v-else-if="phase === 'betting'" class="phase-block">
        <h2>Ставка</h2>
        <div class="bet-cards">
          <button
            v-for="b in ['0','+-','+']"
            :key="b"
            :disabled="alreadyBet"
            :class="{ selected: bet === b }"
            @click="bet = b as any"
          >
            {{ b }}
          </button>
        </div>
        <button :disabled="!bet || alreadyBet" @click="onSendBet">Сделать ставку</button>
      </div>

      <!-- Ответ (advanced) -->
      <div v-else-if="phase === 'answering'" class="phase-block">
        <h2>Ответ на вопрос</h2>
        <div v-if="isAnswering">
          <textarea v-model="answer" placeholder="Введите ваш ответ"></textarea>
          <button :disabled="!answer" @click="onSendAnswer">Отправить ответ</button>
        </div>
        <p v-else>Ответ пишет: {{ answeringName }}. Ждем…</p>
      </div>

      <!-- Догадки (advanced) -->
      <div v-else-if="phase === 'guessing'" class="phase-block">
        <h2>Угадай ответ</h2>
        <div v-if="!isAnswering">
          <textarea v-model="guess" placeholder="Ваш вариант ответа"></textarea>
          <button :disabled="!guess || alreadyGuessed" @click="onSendGuess">Отправить</button>
        </div>
        <p v-else>Ждем догадки других игроков…</p>
      </div>

      <!-- Результаты -->
      <div v-else-if="phase === 'results' || phase === 'advanced_results'" class="results-block">
        <h2>Результаты раунда</h2>
        <div v-if="phase === 'advanced_results' && advancedAnswer">
          Ответ: <strong>{{ advancedAnswer }}</strong>
        </div>
        <div class="votes-list" v-if="voteCounts">
          <div v-for="p in players" :key="p.id">
            <strong>{{ p.nickname }}</strong>
            <template v-if="phase === 'results'">
              — голосов: {{ voteCounts[String(p.id)] ?? 0 }}, ставка: {{ bets[String(p.id)] ?? '-' }},
              очки за раунд: {{ roundScores[String(p.id)] ?? 0 }}, всего: {{ scores[String(p.id)] ?? 0 }}
            </template>
            <template v-else>
              — догадка: {{ guesses[p.id] || '-' }}, очки за раунд: {{ roundScores[p.id] || 0 }}, всего: {{ scores[p.id] || 0 }}
            </template>
          </div>
        </div>
        <button @click="onFinishRound">Следующий раунд</button>
      </div>

      <!-- Конец игры -->
      <div v-else-if="phase === 'game_over'" class="winner-block">
        <h2>Игра завершена</h2>
        <p>Победитель: {{ winnerNameComputed }}</p>
        <button v-if="isHost" @click="startBasic">Начать новую игру</button>
      </div>

      <!-- Таблица очков -->
      <div class="score-table">
        <h3>Текущие очки</h3>
        <table>
          <tr>
            <th>Игрок</th>
            <th>Очки</th>
          </tr>
          <tr v-for="p in players" :key="p.id">
            <td>{{ p.nickname }}</td>
            <td>{{ scores[String(p.id)] ?? 0 }}</td>
          </tr>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/gameStore'

const router = useRouter()
const gameStore = useGameStore()

// Чтение стора
const phase = computed(() => gameStore.gameState.phase || 'lobby')
const gameMode = computed(() => gameStore.gameMode)
const players = computed(() => gameStore.gameState.players)
const roomId = computed(() => gameStore.gameState.roomId)
const myId = computed(() => gameStore.myPlayerId as string)
const isHost = computed(() => gameStore.isHost as boolean)
const canStartBasic = computed(() => gameStore.canStartGame as boolean)
const currentTurnIndex = computed(() => (gameStore.gameState.currentTurn ?? 0) as number)
const currentTurnPlayerId = computed(() => (gameStore.gameState.currentTurnPlayerId ?? (players.value[currentTurnIndex.value]?.id ?? null)) as string | null)
const currentTurnName = computed(() => players.value.find(p => p.id === currentTurnPlayerId.value)?.nickname || '—')

// Данные раундов
const currentQuestion = computed(() => gameStore.gameState.currentQuestion as string | null | undefined)
const votes = computed<Record<string, string[]>>(() => (gameStore.gameState.votes || {}) as Record<string, string[]>)
const bets = computed<Record<string, '0'|'+-'|'+'>>(() => (gameStore.gameState.bets || {}) as Record<string, '0'|'+-'|'+'>)
const scores = computed<Record<string, number>>(() => (gameStore.gameState.scores || {}) as Record<string, number>)
const roundScores = computed<Record<string, number>>(() => (gameStore.gameState.roundScores || {}) as Record<string, number>)
const guesses = computed<Record<string, string>>(() => (gameStore.gameState.guesses || {}) as Record<string, string>)
const voteCounts = computed<Record<string, number>>(() => (gameStore.gameState.voteCounts || {}) as Record<string, number>)
const answeringPlayerId = computed(() => (gameStore.gameState.answeringPlayerId ?? null) as string | null)
const advancedAnswer = computed(() => (gameStore.gameState.advancedAnswer || '') as string)

// Локальные состояния
const selectedVotes = ref<string[]>([])
const bet = ref<'0'|'+-'|'+'|null>(null)
const answer = ref('')
const guess = ref('')

// Статусы уже-отправленных действий
const alreadyVoted = computed(() => !!votes.value[myId.value])
const alreadyBet = computed(() => !!bets.value[myId.value])
const alreadyGuessed = computed(() => !!guesses.value[myId.value])

// Роли
const otherPlayers = computed(() => players.value.filter((p: any) => p.id !== myId.value))
const isMyTurn = computed(() => currentTurnPlayerId.value === myId.value)
const isAnswering = computed(() => !!answeringPlayerId.value && answeringPlayerId.value === myId.value)
const answeringName = computed(() => players.value.find((p: any) => p.id === answeringPlayerId.value)?.nickname || '—')

// Тексты состояния соединения
const connectionStatusText = computed(() => {
  switch (gameStore.connectionStatus) {
    case 'connected':
      return isHost.value ? '🟢 Хост активен' : '🟢 Подключен к хосту'
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
    case 'connected': return 'status-connected'
    case 'connecting': return 'status-connecting'
    case 'disconnected': return 'status-disconnected'
    default: return 'status-unknown'
  }
})

const myIdShort = computed(() => myId.value ? myId.value.slice(0, 6) : '—')
const phaseLabel = computed(() => phase.value)

// Доступности
const isVoteDisabled = (pid: string) =>
  alreadyVoted.value || (selectedVotes.value.length >= 2 && !selectedVotes.value.includes(pid)) || pid === myId.value

// Хэндлеры действий — используем клиентские обертки стора
const startBasic = () => gameStore.startGame('basic')
const startAdvanced = () => gameStore.startGame('advanced')
const onDrawQuestion = () => {
  // Защита: действие доступно только в свою очередь и при активном соединении
  if (!isMyTurn.value) return
  gameStore.drawQuestion()
}
const onSendVote = () => {
  if (selectedVotes.value.length > 0 && selectedVotes.value.length <= 2 && !alreadyVoted.value) {
    gameStore.sendVote([...selectedVotes.value])
  }
}
const onToggleVote = (id: string) => {
  if (alreadyVoted.value) return
  if (id === myId.value) return
  if (selectedVotes.value.includes(id)) {
    selectedVotes.value = selectedVotes.value.filter(x => x !== id)
  } else if (selectedVotes.value.length < 2) {
    selectedVotes.value.push(id)
  }
}
const onSendBet = () => {
  if (bet.value && !alreadyBet.value) {
    gameStore.sendBet(bet.value)
  }
}
const onSendAnswer = () => {
  if (answer.value && isAnswering.value) {
    gameStore.sendAnswer(answer.value)
  }
}
const onSendGuess = () => {
  if (guess.value && !isAnswering.value && !alreadyGuessed.value) {
    gameStore.sendGuess(guess.value)
  }
}
const onFinishRound = () => {
  // Разрешаем нажимать «Следующий раунд» кому угодно: хост выполнит локально, клиент отправит запрос next_round_request
  gameStore.nextRound()
}

const leaveGame = () => {
  gameStore.leaveRoom()
  router.push('/')
}

const winnerNameComputed = computed(() => {
  const allScores = scores.value || {}
  const max = Math.max(0, ...Object.values(allScores))
  const winner = players.value.find(p => (allScores[p.id] || 0) === max)
  return winner ? winner.nickname : '—'
})

// Сброс локальных инпутов на смену фазы
watch(phase, () => {
  // Сбрасываем только то, что не мешает inline-голосованию при drawing_question
  bet.value = null
  answer.value = ''
  guess.value = ''
  // НЕ сбрасываем selectedVotes при появлении вопроса в drawing_question,
  // чтобы пользователь мог выбрать и сразу отправить
  if (phase.value !== 'drawing_question') {
    selectedVotes.value = []
  }
})

// Если сессия невалидна — уходим в меню
watch([() => gameStore.gameState.gameStarted, myId], ([started, id]: [boolean | undefined, string]) => {
  if (!started || !id) {
    // не редиректим агрессивно, пусть остается на экране лобби
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

/* Вспомогательные стили для inline-голосования в фазе вытягивания вопроса */
.vote-inline {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed #ddd;
}
.players-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 12px;
}
.phase-block .question-card {
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #f7f9fc;
  border: 1px solid #e6ecf5;
  font-weight: 600;
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
