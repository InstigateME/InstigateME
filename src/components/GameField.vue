<template>
  <div class="game-field">
    <div class="container">
      <div class="header">
        <h1 class="title">Провокатор</h1>
        <div class="header-actions">
          <RulesDialog  />

          <!-- Кнопка-конверт вынесена в отдельный компонент с дефолтной кнопкой и опциональным слотом -->
          <EnvelopeButton />

          <button class="leave-btn" @click="leaveGame">
            Покинуть игру
          </button>
        </div>
      </div>

      <!-- Лобби -->
      <div v-if="phase === 'lobby'" class="waiting-block">
        <!-- Если идет восстановление или пересинхронизация — не показываем лобби-текст, а статус -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info">
          <p>Переподключение… сохраняем состояние игры.</p>
        </div>
        <template v-else>
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
        </template>
      </div>

      <!-- Вытягивание вопроса -->
      <div v-else-if="phase === 'drawing_question'" class="phase-block draw-block">
        <!-- Глобальная индикация переподключения внутри активной фазы -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <div class="draw-header">
          <h2>Вытягивание вопроса</h2>
          <div class="turn-chip" :title="'Ходит игрок: ' + currentTurnName">
            <span class="chip-dot"></span>
            Ходит: <strong>{{ currentTurnName }}</strong>
          </div>
        </div>

        <div class="question-card question-card--large">
          {{ currentQuestion ?? '—' }}
        </div>

        <div class="draw-actions">
          <button
            class="btn-primary draw-btn"
            v-if="isMyTurn"
            :disabled="!!currentQuestion"
            @click="onDrawQuestion"
          >
            🎲 Вытянуть вопрос
          </button>
          <p v-else class="waiting-note">Ожидаем, пока {{ currentTurnName }} вытянет вопрос…</p>
        </div>

        <!-- Убираем inline-голосование из drawing_question: голосование теперь отображается в фазе voting вместе с карточкой -->
      </div>

      <!-- Голосование (basic/advanced) -->
      <div v-else-if="phase === 'voting' || phase === 'secret_voting'"
           class="phase-block voting-block">
        <!-- Глобальная индикация переподключения -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <!-- Показываем карточку вопроса над голосованием, чтобы она не исчезала после вытягивания -->
        <div class="question-card question-card--large" v-if="currentQuestion">{{
            currentQuestion
          }}
        </div>
        <div class="voting-header">
          <h2>{{ phase === 'voting' ? 'Голосование' : 'Тайное голосование' }}</h2>
          <span class="vote-hint">Выберите до двух игроков</span>
        </div>

        <div class="players-list players-list--voting">
          <button
            v-for="p in otherPlayers"
            :key="p.id"
            :disabled="isVoteDisabled(p.id)"
            :class="{ selected: selectedVotes.includes(p.id) }"
            @click="onToggleVote(p.id)"
            class="vote-chip"
            :title="'Голос за: ' + p.nickname"
          >
            <span class="vote-chip__name">{{ p.nickname }}</span>
            <span class="vote-chip__marker" v-if="selectedVotes.includes(p.id)">✓</span>
          </button>
        </div>

        <div class="voting-actions">
          <button
            class="btn-primary vote-submit"
            :disabled="selectedVotes.length === 0 || selectedVotes.length > 2 || alreadyVoted"
            @click="onSendVote"
          >
            Отправить голос ({{ selectedVotes.length }}/2)
          </button>
          <span v-if="alreadyVoted" class="voted-note">Голос отправлен</span>
        </div>
      </div>

      <!-- Ставки (basic) -->
      <div v-else-if="phase === 'betting'" class="phase-block betting-block">
        <!-- Глобальная индикация переподключения -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <div class="betting-header">
          <h2>Ставка</h2>
          <span class="bet-hint">Выберите один вариант</span>
        </div>

        <div class="bet-cards">
          <button
            v-for="b in ['0','±','+']"
            :key="b"
            :disabled="alreadyBet"
            :class="['bet-chip', { selected: bet === b, 'bet-plus': b === '+', 'bet-plusminus': b === '±', 'bet-zero': b === '0' }]"
            @click="bet = b as any"
            :title="'Ставка: ' + b"
          >
            <span class="bet-sign"
                  :class="{'bet-plus': b === '+', 'bet-plusminus': b === '±', 'bet-zero': b === '0'}">{{
                b
              }}</span>
          </button>
        </div>

        <div class="betting-actions">
          <button class="btn-primary bet-submit" :disabled="!bet || alreadyBet" @click="onSendBet">
            Подтвердить ставку
          </button>
          <span v-if="alreadyBet" class="bet-note">Ставка отправлена</span>
        </div>
      </div>

      <!-- Ответ (advanced) -->
      <div v-else-if="phase === 'answering'" class="phase-block answering-block">
        <!-- Глобальная индикация переподключения -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <div class="answering-header">
          <h2>Ответ на вопрос</h2>
          <span class="answering-hint" v-if="isAnswering">Напишите короткий и ясный ответ</span>
          <span class="answering-hint" v-else>Ждем ответ от: {{ answeringName }}</span>
        </div>

        <div v-if="isAnswering" class="answering-content">
          <textarea class="answering-textarea" v-model="answer" placeholder="Введите ваш ответ"></textarea>
          <div class="answering-actions">
            <button class="btn-primary answering-submit" :disabled="!answer" @click="onSendAnswer">Отправить ответ</button>
          </div>
        </div>

        <div v-else class="answering-wait">
          <div class="wait-bubble">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
          <p class="wait-note">Ответ пишет: <strong>{{ answeringName }}</strong>. Ждем…</p>
        </div>
      </div>

      <!-- Догадки (advanced) -->
      <div v-else-if="phase === 'guessing'" class="phase-block guessing-block">
        <!-- Глобальная индикация переподключения -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <div class="guessing-header">
          <h2>Угадай ответ</h2>
          <span class="guessing-hint" v-if="!isAnswering">Попробуйте угадать максимально точно</span>
          <span class="guessing-hint" v-else>Вы автор ответа — ожидание догадок</span>
        </div>

        <div v-if="!isAnswering" class="guessing-content">
          <textarea class="guessing-textarea" v-model="guess" placeholder="Ваш вариант ответа"></textarea>
          <div class="guessing-actions">
            <button class="btn-primary guessing-submit" :disabled="!guess || alreadyGuessed" @click="onSendGuess">Отправить</button>
            <span v-if="alreadyGuessed" class="guess-note">Догадка отправлена</span>
          </div>
        </div>

        <div v-else class="guessing-wait">
          <div class="wait-bubble">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
          <p class="wait-note">Ждем догадки других игроков…</p>
        </div>
      </div>

      <!-- Выбор победителей (advanced) -->
      <div v-else-if="phase === 'selecting_winners'" class="phase-block winners-block">
        <!-- Глобальная индикация переподключения -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <div class="winners-header">
          <h2>Выберите близкие по смыслу ответы</h2>
          <span class="winners-hint">Выбирает: <strong>{{ currentTurnName }}</strong></span>
        </div>
        <!-- Показываем загаданный ответ ТОЛЬКО автору (игроку, который его загадал) -->
        <div v-if="isAnswering && advancedAnswer" class="author-answer">
          <div class="author-answer__label">Загаданный ответ</div>
          <div class="author-answer__text">{{ advancedAnswer }}</div>
        </div>

        <div v-if="isChooser" class="winners-select">
          <p class="winners-note">Отметьте одного или нескольких игроков. Каждый выбранный получит +1 балл.</p>
          <div class="winners-list">
            <button
              v-for="p in selectablePlayers"
              :key="p.id"
              class="winner-chip"
              :class="{ selected: selectedWinners.includes(p.id) }"
              @click="toggleWinner(p.id)"
              :title="(guesses[p.id] || 'нет ответа')"
            >
              <span class="winner-chip__name">{{ p.nickname }}</span>
              <span class="winner-chip__guess">{{ guesses[p.id] || 'нет ответа' }}</span>
              <span class="winner-chip__marker" v-if="selectedWinners.includes(p.id)">✓</span>
            </button>
          </div>
          <div class="winners-actions">
            <button class="btn-primary winners-confirm" :disabled="selectedWinners.length === 0" @click="onSendWinners">
              Подтвердить выбор ({{ selectedWinners.length }})
            </button>
            <button class="btn-secondary winners-none" :disabled="selectedWinners.length > 0" @click="onSendNoWinners">
              Никто не угадал
            </button>
          </div>
        </div>

        <div v-else class="winners-wait">
          <p class="wait-note">Ожидаем, пока <strong>{{ currentTurnName }}</strong> выберет победителей...</p>
          <ul class="winners-answers">
            <li v-for="p in players" :key="p.id">
              <strong>{{ p.nickname }}</strong>
              —
              <template v-if="p.id === answeringPlayerId">
                загадал: {{ advancedAnswer || '—' }}
              </template>
              <template v-else>
                <span v-if="guesses[p.id]">ответил: {{ guesses[p.id] }}</span>
                <span v-else>нет ответа</span>
              </template>
            </li>
          </ul>
        </div>
      </div>

      <!-- Результаты -->
      <div v-else-if="phase === 'results' || phase === 'advanced_results'" class="results-block">
        <!-- Глобальная индикация переподключения -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <h2>Результаты раунда</h2>
        <div v-if="phase === 'advanced_results' && advancedAnswer" class="advanced-answer">
          Ответ: <strong>{{ advancedAnswer }}</strong>
        </div>
        <div class="results-table-wrapper" v-if="voteCounts">
          <table
            v-if="phase === 'results'"
            class="results-table"
          >
            <thead>
              <tr>
                <th>Игрок</th>
                <th>Голоса</th>
                <th>Ставка</th>
                <th>Раунд</th>
                <th>Всего</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in players" :key="p.id">
                <td class="col-name">{{ p.nickname }}</td>
                <td>{{ voteCounts[String(p.id)] ?? 0 }}</td>
                <td>{{ bets[String(p.id)] ?? '-' }}</td>
                <td>{{ roundScores[String(p.id)] ?? 0 }}</td>
                <td class="col-total">{{ scores[String(p.id)] ?? 0 }}</td>
              </tr>
            </tbody>
          </table>
          <table
            v-else
            class="results-table"
          >
            <thead>
              <tr>
                <th>Игрок</th>
                <th>Догадка</th>
                <th>Раунд</th>
                <th>Всего</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in players" :key="p.id">
                <td class="col-name">{{ p.nickname }}</td>
                <td class="col-guess">{{ guesses[p.id] || '-' }}</td>
                <td>{{ roundScores[p.id] || 0 }}</td>
                <td class="col-total">{{ scores[p.id] || 0 }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <button class="next-round-btn" @click="onFinishRound">Следующий раунд</button>
      </div>

      <!-- Конец игры -->
      <div v-else-if="phase === 'game_over'" class="winner-block">
        <!-- Глобальная индикация переподключения -->
        <div v-if="gameStore.connectionStatus !== 'connected'" class="reconnect-info" style="margin-bottom:10px">
          Переподключение… сохраняем состояние игры.
        </div>
        <h2>Игра завершена</h2>
        <p>Победитель: {{ winnerNameComputed }}</p>
        <button v-if="isHost" @click="startBasic">Начать новую игру</button>
      </div>

      <!-- Таблица очков -->
      <div class="bottom-section">
        <div class="score-table results-block">
          <h2>Текущие очки</h2>
          <div class="results-table-wrapper">
            <table class="results-table">
              <thead>
              <tr>
                <th>Игрок</th>
                <th>Очки</th>
              </tr>
              </thead>
              <tbody>
              <tr v-for="p in players" :key="p.id">
                <td class="col-name">
                  <span class="name-with-status">
                    <span class="name-text">{{ p.nickname }}</span>
                    <span
                      v-if="roundStatusText(p.id) !== '—'"
                      class="status-pill"
                      :class="roundStatusClass(p.id)"
                      :title="roundStatusTitle(p.id)"
                      aria-hidden="true"
                    >
                      {{ roundStatusIcon(p.id) }}
                    </span>
                  </span>
                </td>
                <td class="col-total">{{ scores[String(p.id)] ?? 0 }}</td>
              </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Нижняя панель состояния -->
        <div class="game-info">
          <p class="players-count">
            Игроков: {{ players.length }} • Я: {{ myNickname }} (ID: {{ myIdShort }}) •
            {{ isHost ? 'Хост' : 'Клиент' }}
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

          <!-- Debug panel -->
          <div class="debug-panel">
            <div class="debug-actions">
              <button class="btn-secondary" @click="copyDebug">Copy Debug</button>
              <span v-if="copiedOk" class="copy-status">Скопировано</span>
              <span v-else class="copy-hint">Снимок состояния ниже</span>
            </div>
            <pre class="debug-pre">{{ debugJson }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Popup правил -->
    <!-- Инстанс RulesDialog уже используется как обертка для кнопки и управляется тем же v-model -->
  </div>
</template>

<script setup lang="ts">
import {ref, computed, watch} from 'vue'
import {useRouter} from 'vue-router'
import {useGameStore} from '@/stores/gameStore'

const router = useRouter()
const gameStore = useGameStore()

// Debug panel state
const copiedOk = ref(false)
const debugPayload = computed(() => {
  // Берём минимально запрошенный срез
  return {
    state: gameStore.gameState,
    peers: gameStore.peerService?.getActiveConnections
      ? gameStore.peerService.getActiveConnections()
      : [],
    allKnownPeers: gameStore.peerService?.getAllKnownPeers
      ? gameStore.peerService.getAllKnownPeers()
      : [],
    role: gameStore.peerService?.getCurrentRole
      ? gameStore.peerService.getCurrentRole()
      : (gameStore.isHost ? 'host' : 'client'),
    myId: (gameStore.myPlayerId as string) || '',
    roomId: (gameStore.gameState.roomId as string) || ''
  }
})
const debugJson = computed(() => {
  try {
    return JSON.stringify(debugPayload.value, null, 2)
  } catch (e) {
    return 'Failed to stringify debug payload'
  }
})
async function copyDebug() {
  try {
    await navigator.clipboard.writeText(debugJson.value)
    copiedOk.value = true
    setTimeout(() => (copiedOk.value = false), 1200)
  } catch (e) {
    copiedOk.value = false
    console.error('[Debug] Clipboard write failed', e)
  }
}

import RulesDialog from './RulesDialog.vue'
import EnvelopeButton from './EnvelopeButton.vue'

// Чтение стора
const phase = computed(() => {
  // Если мы переподключаемся, не форсим 'lobby', оставляем последнюю известную фазу
  const savedPhase = gameStore.gameState.phase
  if (gameStore.connectionStatus !== 'connected' && savedPhase) {
    return savedPhase
  }
  return savedPhase || 'lobby'
})
const gameMode = computed(() => (gameStore.gameState.gameMode as 'basic' | 'advanced' | undefined) || (gameStore.gameMode as 'basic' | 'advanced'))
const players = computed(() => gameStore.gameState.players)
const roomId = computed(() => gameStore.gameState.roomId)
const myId = computed(() => gameStore.myPlayerId as string)
const isHost = computed(() => gameStore.isHost as boolean)
const canStartBasic = computed(() => {
  // Во время переподключения нельзя показывать доступность старта
  if (gameStore.connectionStatus !== 'connected') return false
  return gameStore.canStartGame as boolean
})
const currentTurnIndex = computed(() => (gameStore.gameState.currentTurn ?? 0) as number)
const currentTurnPlayerId = computed(() => (gameStore.gameState.currentTurnPlayerId ?? (players.value[currentTurnIndex.value]?.id ?? null)) as string | null)
const currentTurnName = computed(() => players.value.find(p => p.id === currentTurnPlayerId.value)?.nickname || '—')

// Данные раундов
const currentQuestion = computed(() => gameStore.gameState.currentQuestion as string | null | undefined)
const votes = computed<Record<string, string[]>>(() => (gameStore.gameState.votes || {}) as Record<string, string[]>)
const bets = computed<Record<string, '0' | '±' | '+'>>(() => (gameStore.gameState.bets || {}) as Record<string, '0' | '±' | '+'>)
const scores = computed<Record<string, number>>(() => (gameStore.gameState.scores || {}) as Record<string, number>)
const roundScores = computed<Record<string, number>>(() => (gameStore.gameState.roundScores || {}) as Record<string, number>)
const guesses = computed<Record<string, string>>(() => (gameStore.gameState.guesses || {}) as Record<string, string>)
// Утилиты статуса текущего раунда для таблицы очков
const roundStatusText = (pid: string) => {
  // drawing_question: явно ждем текущего игрока
  if (phase.value === 'drawing_question') {
    if (currentTurnPlayerId.value === pid && !currentQuestion.value) return 'Ждем ход'
    return '—'
  }
  // selecting_winners (advanced): ожидаем только ход текущего игрока, остальные — без статуса
  if (phase.value === 'selecting_winners') {
    if (currentTurnPlayerId.value === pid) return 'Ждем ход'
    return '—'
  }
  // advanced: если игрок отвечает — показываем "Отвечает"
  if (phase.value === 'answering' && answeringPlayerId.value === pid) return 'Отвечает'
  // advanced: если игрок не автор ответа и уже отправил догадку
  if (phase.value === 'guessing' && guesses.value[pid]) return 'Догадка отправлена'
  if (phase.value === 'guessing' && !guesses.value[pid] && pid !== (answeringPlayerId.value ?? '')) return 'Ждем догадку'
  // basic: голосование — отметим тех, кто проголосовал
  if ((phase.value === 'voting' || phase.value === 'secret_voting') && votes.value[pid]) return 'Проголосовал'
  if ((phase.value === 'voting' || phase.value === 'secret_voting') && !votes.value[pid]) return 'Ждем голос'
  // basic: ставки
  if (phase.value === 'betting' && bets.value[pid]) return 'Ставка сделана'
  if (phase.value === 'betting' && !bets.value[pid]) return 'Ждем ставку'
  // результаты/остальные фазы
  return '—'
}
const roundStatusClass = (pid: string) => {
  const t = roundStatusText(pid)
  if (t === 'Ждем ход') return 'status-wait'
  /* selecting_winners */
  /* "Ждем ход" уже помечаем как status-wait; для остальных пусто */
  if (t === 'Проголосовал' || t === 'Ставка сделана' || t === 'Догадка отправлена') return 'status-done'
  if (t === 'Ждем голос' || t === 'Ждем ставку' || t === 'Ждем догадку') return 'status-wait'
  if (t === 'Отвечает') return 'status-active'
  return 'status-neutral'
}
const roundStatusIcon = (pid: string) => {
  const t = roundStatusText(pid)
  // Иконки: выполнено ✅, ожидание ⏳, активное ✍️, пусто •, ожидание конкретного хода 🎲
  if (t === 'Ждем ход') return '🎲'
  if (t === 'Проголосовал' || t === 'Ставка сделана' || t === 'Догадка отправлена') return '✅'
  if (t === 'Ждем голос' || t === 'Ждем ставку' || t === 'Ждем догадку') return '⏳'
  if (t === 'Отвечает') return '✍️'
  return '•'
}
const roundStatusTitle = (pid: string) => {
  const t = roundStatusText(pid)
  return t === '—' ? `Фаза: ${phaseLabel.value}` : `Фаза: ${phaseLabel.value} — ${t}`
}
const voteCounts = computed<Record<string, number>>(() => (gameStore.gameState.voteCounts || {}) as Record<string, number>)
const answeringPlayerId = computed(() => (gameStore.gameState.answeringPlayerId ?? null) as string | null)
const advancedAnswer = computed(() => (gameStore.gameState.advancedAnswer || '') as string)

// Локальные состояния
const selectedVotes = ref<string[]>([])
const bet = ref<'0' | '±' | '+' | null>(null)
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
const isChooser = computed(() => myId.value === (answeringPlayerId.value ?? ''))
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

const myIdShort = computed(() => myId.value ? myId.value.slice(0, 6) : '—')
const myNickname = computed(() => players.value.find(p => p.id === myId.value)?.nickname || '—')
const phaseLabel = computed(() => phase.value)

// Доступности
const isVoteDisabled = (pid: string) =>
  alreadyVoted.value || (selectedVotes.value.length >= 2 && !selectedVotes.value.includes(pid)) || pid === myId.value

// Хэндлеры действий — используем клиентские обертки стора
const startBasic = () => {
  if (gameStore.connectionStatus !== 'connected') return
  gameStore.startGame('basic')
}
const startAdvanced = () => {
  if (gameStore.connectionStatus !== 'connected') return
  gameStore.startGame('advanced')
}
const onDrawQuestion = () => {
  // Защита: действие доступно только в свою очередь и при активном соединении
  if (!isMyTurn.value) return
  if (gameStore.connectionStatus !== 'connected') return
  gameStore.drawQuestion()
}
const onSendVote = () => {
  if (gameStore.connectionStatus !== 'connected') return
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
  if (gameStore.connectionStatus !== 'connected') return
  if (bet.value && !alreadyBet.value) {
    gameStore.sendBet(bet.value)
  }
}
const onSendAnswer = () => {
  if (gameStore.connectionStatus !== 'connected') return
  if (answer.value && isAnswering.value) {
    gameStore.sendAnswer(answer.value)
  }
}
const onSendGuess = () => {
  if (gameStore.connectionStatus !== 'connected') return
  if (guess.value && !isAnswering.value && !alreadyGuessed.value) {
    gameStore.sendGuess(guess.value)
  }
}
const selectedWinners = ref<string[]>([])
const selectablePlayers = computed(() =>
  // Только игроки, у которых есть guess, исключая автора ответа (chooser) и самого себя (на клиенте)
  players.value.filter(p =>
    p.id !== (answeringPlayerId.value ?? '') &&
    p.id !== myId.value &&
    !!guesses.value[p.id]
  )
)
const toggleWinner = (pid: string) => {
  if (!isChooser.value) return
  if (selectedWinners.value.includes(pid)) {
    selectedWinners.value = selectedWinners.value.filter(id => id !== pid)
  } else {
    selectedWinners.value.push(pid)
  }
}
const onSendWinners = () => {
  if (gameStore.connectionStatus !== 'connected') return
  if (!isChooser.value || selectedWinners.value.length === 0) return
  gameStore.sendWinners([...selectedWinners.value])
}
const onSendNoWinners = () => {
  if (gameStore.connectionStatus !== 'connected') return
  if (!isChooser.value) return
  // Завершить раунд без победителей — отправляем пустой список
  gameStore.sendWinners([])
}
const onFinishRound = () => {
  if (gameStore.connectionStatus !== 'connected') return
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
  display: flex;
  flex-direction: column;
  gap: 20px;
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
  padding: 16px 18px;
  background: #f8f9fa;
  border-radius: 12px;
  border: 1px solid #eef1f4;
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

/* Debug panel */
.debug-panel {
  margin-top: 10px;
  text-align: left;
  background: #fff;
  border: 1px dashed #cbd5e1;
  border-radius: 10px;
  padding: 8px;
}
.debug-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.copy-status {
  color: #166534;
  font-weight: 700;
}
.copy-hint {
  color: #64748b;
}
.debug-pre {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  background: #0b1020;
  color: #d1e7ff;
  border-radius: 8px;
  padding: 8px;
  font-size: 12px;
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

/* Header actions */
.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.help-btn {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  border: 1px solid #e6ecf5;
  background: #f8fafc;
  color: #1f2937;
  font-size: 20px;
  font-weight: 800;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  transition: transform 0.12s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}
.help-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(30, 60, 114, 0.08);
  border-color: #dbe6f3;
  background: #ffffff;
}
/* Стили для конверта, наследуем оформление help-btn */
.envelope-btn {
  padding: 0;
}
.envelope-icon {
  width: 22px;
  height: 22px;
  color: #1f2937;
}

/* Modal (popup) */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 1000;
}
.modal {
  width: min(900px, 100%);
  background: #fff;
  border-radius: 14px;
  border: 1px solid #e6ecf5;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.25);
  display: flex;
  flex-direction: column;
  max-height: 80vh;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #eef2f7;
}
.modal-header h3 {
  margin: 0;
}
.modal-close {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid #e6ecf5;
  background: #f8fafc;
  color: #1f2937;
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
}
.modal-content {
  padding: 12px 16px;
  overflow: auto;
}

/* Стилизация правил в духе productContext: читаемо, структурно, с акцентами на ценностях */
.rules {
  display: grid;
  gap: 12px;
  color: #0f172a;
}
.rules__header {
  display: grid;
  gap: 6px;
  padding: 4px 0 8px;
  border-bottom: 1px solid #eef2f7;
}
.rules__title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 800;
  letter-spacing: 0.2px;
}
.rules__subtitle {
  margin: 0;
  color: #475569;
  font-size: 0.95rem;
}
.rules__section {
  display: grid;
  gap: 6px;
}
.rules__h {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
  color: #1f2937;
}
.rules__p {
  margin: 0;
  line-height: 1.5;
}
.rules__list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.5;
}
.rules__bullets {
  margin: 0;
  padding-left: 18px;
  line-height: 1.5;
  list-style: disc;
}
.rules strong {
  font-weight: 800;
}

/* Адаптивность текста правил */
@media (max-width: 560px) {
  .rules__title { font-size: 1.05rem; }
  .rules__subtitle { font-size: 0.9rem; }
  .rules__h { font-size: 0.98rem; }
}
.modal-footer {
  padding: 12px 16px;
  border-top: 1px solid #eef2f7;
  display: flex;
  justify-content: flex-end;
}
.modal-footer .btn-primary {
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  color: #fff;
  border: none;
  padding: 8px 14px;
  border-radius: 10px;
  font-weight: 800;
  cursor: pointer;
}

/* Голосование */
.voting-block {
  background: #f9fbff;
  border: 1px solid #e6ecf5;
  border-radius: 14px;
  padding: 16px;
}

.voting-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.vote-hint {
  color: #667085;
  font-size: 0.95rem;
}

.players-list--voting {
  gap: 10px;
  margin: 10px 0 14px;
}

.vote-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid #e6ecf5;
  background: #ffffff;
  color: #2c3e50;
  font-weight: 600;
  transition: transform 0.12s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease;
  cursor: pointer;
}

.vote-chip:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(30, 60, 114, 0.08);
  border-color: #dbe6f3;
}

.vote-chip.selected {
  background: #eef6ff;
  border-color: #cfe2ff;
  box-shadow: 0 6px 14px rgba(36, 99, 235, 0.12);
}

.vote-chip:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.vote-chip__name {
  max-width: 160px;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.vote-chip__marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #2ecc71;
  color: #fff;
  font-size: 12px;
  font-weight: 900;
}

.voting-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.btn-primary.vote-submit {
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  color: #fff;
  border: none;
  padding: 10px 16px;
  border-radius: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
  box-shadow: 0 6px 14px rgba(22, 163, 74, 0.18);
}

.btn-primary.vote-submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(22, 163, 74, 0.24);
}

.btn-primary.vote-submit:disabled {
  opacity: 0.6;
  filter: grayscale(0.1);
  cursor: not-allowed;
}

.voted-note {
  color: #667085;
  font-size: 0.95rem;
}

/* Адаптивность голосования */
@media (max-width: 560px) {
  .voting-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .players-list--voting {
    gap: 8px;
  }

  .vote-chip__name {
    max-width: 120px;
  }

  .voting-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .btn-primary.vote-submit {
    width: 100%;
  }
}

/* Вытягивание вопроса */
.draw-block {
  background: #f9fbff;
  border: 1px solid #e6ecf5;
  border-radius: 14px;
  padding: 16px;
}

.draw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.turn-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #eef6ff;
  color: #1b4b8a;
  border: 1px solid #cfe2ff;
  padding: 6px 10px;
  border-radius: 999px;
  font-weight: 600;
  white-space: nowrap;
}

.turn-chip .chip-dot {
  width: 8px;
  height: 8px;
  background: #2ecc71;
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(46, 204, 113, 0.15);
}

.question-card--large {
  font-size: 1.05rem;
  line-height: 1.4;
  padding: 14px 16px;
  border-width: 1px;
  margin-bottom: 14px;
}

.draw-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.btn-primary.draw-btn {
  background: linear-gradient(135deg, #6a89cc 0%, #4a69bd 100%);
  color: #fff;
  border: none;
  padding: 12px 18px;
  border-radius: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.2s ease, filter 0.2s ease;
  box-shadow: 0 6px 14px rgba(74, 105, 189, 0.25);
}

.btn-primary.draw-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(74, 105, 189, 0.28);
}

.btn-primary.draw-btn:disabled {
  opacity: 0.7;
  filter: grayscale(0.1);
  cursor: not-allowed;
}

.waiting-note {
  margin: 0;
  color: #576574;
  font-size: 0.95rem;
}

/* Моб. адаптация для draw-block */
@media (max-width: 560px) {
  .draw-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .draw-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .btn-primary.draw-btn {
    width: 100%;
  }
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

.results-block {
  background: #f9fbff;
  border: 1px solid #e6ecf5;
  border-radius: 14px;
  padding: 12px;
}

.results-block h2 {
  margin: 0 0 8px 0;
}

/* выравниваем заголовок очков под стиль результатов */
.score-table h2 {
  margin: 0 0 8px 0;
}

.advanced-answer {
  margin-bottom: 8px;
}

.results-table-wrapper {
  overflow-x: auto;
}

.results-table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #eef2f7;
  border-radius: 10px;
  overflow: hidden;
  font-size: 0.95rem;
}

/* Ответ на вопрос */
.answering-block {
  background: #f9fbff;
  border: 1px solid #e6ecf5;
  border-radius: 14px;
  padding: 16px;
}
.answering-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.answering-hint {
  color: #667085;
  font-size: 0.95rem;
}
.answering-content {
  display: grid;
  gap: 10px;
}
.answering-textarea {
  width: 100%;
  min-height: 110px;
  resize: vertical;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid #dfe7f2;
  background: #ffffff;
  font-size: 1rem;
  line-height: 1.4;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.answering-textarea:focus {
  outline: none;
  border-color: #98b7ff;
  box-shadow: 0 0 0 3px rgba(152, 183, 255, 0.25);
}
.answering-actions {
  display: flex;
  justify-content: flex-end;
}
.btn-primary.answering-submit {
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  color: #fff;
  border: none;
  padding: 10px 16px;
  border-radius: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
  box-shadow: 0 6px 14px rgba(59, 130, 246, 0.18);
}
.btn-primary.answering-submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(59, 130, 246, 0.26);
}
.btn-primary.answering-submit:disabled {
  opacity: 0.6;
  filter: grayscale(0.1);
  cursor: not-allowed;
}
.answering-wait .wait-note {
  color: #667085;
  font-size: 0.95rem;
  margin-top: 8px;
}

/* Угадай ответ */
.guessing-block {
  background: #f9fbff;
  border: 1px solid #e6ecf5;
  border-radius: 14px;
  padding: 16px;
}
.guessing-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.guessing-hint {
  color: #667085;
  font-size: 0.95rem;
}
.guessing-content {
  display: grid;
  gap: 10px;
}
.guessing-textarea {
  width: 100%;
  min-height: 90px;
  resize: vertical;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid #dfe7f2;
  background: #ffffff;
  font-size: 1rem;
  line-height: 1.4;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.guessing-textarea:focus {
  outline: none;
  border-color: #98b7ff;
  box-shadow: 0 0 0 3px rgba(152, 183, 255, 0.25);
}
.guessing-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
}
.btn-primary.guessing-submit {
  background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
  color: #fff;
  border: none;
  padding: 10px 16px;
  border-radius: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
  box-shadow: 0 6px 14px rgba(16, 185, 129, 0.18);
}
.btn-primary.guessing-submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(16, 185, 129, 0.26);
}
.btn-primary.guessing-submit:disabled {
  opacity: 0.6;
  filter: grayscale(0.1);
  cursor: not-allowed;
}
.guess-note {
  color: #667085;
  font-size: 0.95rem;
}
.guessing-wait .wait-note {
  color: #667085;
  font-size: 0.95rem;
  margin-top: 8px;
}

/* Блок авторского ответа во время выбора победителей */
.author-answer {
  margin: 10px 0 12px;
  padding: 10px 12px;
  border: 1px solid #dfe7f2;
  border-radius: 12px;
  background: #ffffff;
}
.author-answer__label {
  font-size: 0.9rem;
  color: #64748b;
  margin-bottom: 6px;
}
.author-answer__text {
  font-weight: 700;
  color: #0f172a;
  line-height: 1.35;
  white-space: pre-wrap;
}
@media (max-width: 560px) {
  .author-answer {
    padding: 8px 10px;
  }
  .author-answer__text {
    font-size: 0.95rem;
  }
}

/* Общая "пузырь" индикация ожидания */
.wait-bubble {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.wait-bubble .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #a5b4fc;
  animation: dotBlink 1.4s infinite ease-in-out;
}
.wait-bubble .dot:nth-child(2) { animation-delay: 0.2s; }
.wait-bubble .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotBlink {
  0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}

/* Ставка */
.betting-block {
  background: #f9fbff;
  border: 1px solid #e6ecf5;
  border-radius: 14px;
  padding: 16px;
}

.betting-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.bet-hint {
  color: #667085;
  font-size: 0.95rem;
}

/* 3 в ряд через CSS Grid + разноцветные варианты и ховеры */
.bet-cards {
  margin: 10px 0 14px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.bet-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 14px 0;
  border-radius: 12px;
  border: 1px solid #e6ecf5;
  background: #ffffff;
  color: #2c3e50;
  font-weight: 800;
  font-size: 1.05rem;
  letter-spacing: 0.5px;
  cursor: pointer !important; /* принудительно указываем pointer */
  user-select: none;
  transition: transform 0.12s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.bet-chip:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(30, 60, 114, 0.08);
  border-color: #cfe2ff;
  cursor: pointer; /* явно указываем и в :hover */
}

.bet-chip.selected[data-v-] {
  /* safeguard selector when scoped hashing is applied */
}

.bet-chip.selected {
  box-shadow: 0 6px 14px rgba(36, 99, 235, 0.12);
}

.bet-chip  {
  cursor: pointer;
}

/* Разные цвета для значений */
.bet-chip .bet-sign.bet-plus {
  color: #0a7c2f;
}

.bet-chip .bet-sign.bet-plusminus {
  color: #6d28d9;
}

.bet-chip .bet-sign.bet-zero {
  color: #6b7280;
}

/* Цвет текста при hover */
.bet-chip:hover .bet-sign.bet-plus {
  color: #065f22;
}

.bet-chip:hover .bet-sign.bet-plusminus {
  color: #5b21b6;
}

.bet-chip:hover .bet-sign.bet-zero {
  color: #4b5563;
}

/* Цвет текста при selected */
.bet-chip.selected .bet-sign.bet-plus {
  color: #0a7c2f;
}

.bet-chip.selected .bet-sign.bet-plusminus {
  color: #6d28d9;
}

.bet-chip.selected .bet-sign.bet-zero {
  color: #111827;
}

/* Фоновая подсветка выбранных по типу */
.bet-chip.selected.bet-plus {
  background: #e9f9ef;
  border-color: #b8f0cd;
}

.bet-chip.selected.bet-plusminus {
  background: #f0e9ff;
  border-color: #dec8ff;
}

.bet-chip.selected.bet-zero {
  background: #f3f4f6;
  border-color: #e5e7eb;
}

/* Наведение меняет курсор и легкий градиент */
.bet-chip {
  cursor: pointer;
}

.bet-chip:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), #f7fafc);
}

.bet-chip:disabled {
  opacity: 0.6;
  cursor: not-allowed !important; /* блокируем pointer в disabled */
}

/* Адаптивная перегруппировка: 2 в ряд на средних, 1 в ряд на узких */
@media (max-width: 720px) {
  .bet-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 420px) {
  .bet-cards {
    grid-template-columns: 1fr;
  }
}

.betting-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.btn-primary.bet-submit {
  background: linear-gradient(135deg, #ff7f50 0%, #ff5f30 100%);
  color: #fff;
  border: none;
  padding: 10px 16px;
  border-radius: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
  box-shadow: 0 6px 14px rgba(255, 95, 48, 0.2);
}

.btn-primary.bet-submit:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(255, 95, 48, 0.28);
}

.btn-primary.bet-submit:disabled {
  opacity: 0.6;
  filter: grayscale(0.1);
  cursor: not-allowed;
}

.bet-note {
  color: #667085;
  font-size: 0.95rem;
}

/* Адаптивность ставок (дополнили флоат-сетку выше) */
@media (max-width: 560px) {
  .betting-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .btn-primary.bet-submit {
    width: 100%;
  }
}

/* Стили "Текущие очки" — унификация под таблицу результатов */
.score-table .results-table {
  width: 100%;
}

.score-table .col-name {
  font-weight: 700;
  color: #2c3e50;
}

.score-table .col-total {
  font-weight: 700;
  text-align: right;
}
.col-status {
  white-space: nowrap;
}
.name-with-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.name-text {
  max-width: 220px;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 800;
  border: 1px solid transparent;
  line-height: 1;
}
.status-done {
  background: #e7f6ec;
  color: #166534;
  border-color: #bbebc8;
}
.status-wait {
  background: #fff4e0;
  color: #854d0e;
  border-color: #fde3b1;
}
.status-active {
  background: #e7f1ff;
  color: #1e40af;
  border-color: #cfe2ff;
}
.status-neutral {
  background: #f1f5f9;
  color: #334155;
  border-color: #e2e8f0;
}

.results-table thead {
  background: #f3f6fb;
}

.results-table th,
.results-table td {
  padding: 8px 10px;
  border-bottom: 1px solid #eef2f7;
  text-align: left;
  white-space: nowrap;
}

.results-table tbody tr:nth-child(even) {
  background: #fbfdff;
}

.results-table th:first-child,
.results-table td:first-child {
  position: sticky;
  left: 0;
  background: inherit;
}

.col-name {
  font-weight: 700;
  color: #2c3e50;
}

.col-total {
  font-weight: 700;
}

.col-guess {
  max-width: 420px;
  white-space: normal;
}

.next-round-btn {
  margin-top: 12px;
  background: #2ecc71;
  color: #fff;
  border: none;
  padding: 10px 18px;
  border-radius: 10px;
  font-weight: 700;
  cursor: pointer;
}

.next-round-btn:hover {
  filter: brightness(0.95);
}

.bottom-section {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}

/* Мобильная адаптация */
@media (max-width: 800px) {
  .bottom-section {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .game-info {
    padding: 12px 14px;
    font-size: 0.95rem;
  }

  .players-count {
    font-size: 1rem;
    margin-bottom: 6px;
  }

  .status-info {
    gap: 6px;
  }

  .connection-status {
    font-size: 0.85rem;
    padding: 6px 12px;
  }

  .results-block {
    padding: 10px;
  }

  .results-table {
    font-size: 0.9rem;
  }

  .results-table th,
  .results-table td {
    padding: 6px 8px;
  }

  .col-guess {
    max-width: 100%;
  }

  .next-round-btn {
    width: 100%;
  }
}

@media (max-width: 560px) {
  .header {
    flex-direction: column;
    gap: 10px;
    align-items: stretch;
    text-align: center;
  }
  .name-text {
    max-width: 160px;
  }

  .leave-btn {
    width: 100%;
  }

  .container {
    padding: 20px;
    border-radius: 16px;
  }

  .title {
    font-size: 1.6rem;
  }

  .players-list {
    gap: 6px;
  }

  .phase-block .question-card {
    padding: 10px 12px;
    font-size: 0.95rem;
  }

  .score-table table {
    width: 100%;
  }

  .score-table th,
  .score-table td {
    padding: 6px;
    font-size: 0.9rem;
  }
}

@media (max-width: 380px) {
  .results-table th,
  .results-table td {
    padding: 6px;
    white-space: normal;
  }
}

.phase-block .question-card {
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #f7f9fc;
  border: 1px solid #e6ecf5;
  font-weight: 600;
}

/* Выбор победителей */
.winners-block {
  background: #f9fbff;
  border: 1px solid #e6ecf5;
  border-radius: 14px;
  padding: 16px;
}
.winners-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.winners-hint {
  color: #667085;
  font-size: 0.95rem;
}
.winners-note {
  color: #667085;
  margin: 0 0 8px 0;
}
.winners-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  margin-bottom: 10px;
}
.winner-chip {
  position: relative;
  display: grid;
  grid-template-columns: 160px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid #e6ecf5;
  background: #ffffff;
  color: #2c3e50;
  transition: transform 0.12s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease;
  cursor: pointer;
  text-align: left;
}
.winner-chip:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(30, 60, 114, 0.08);
  border-color: #dbe6f3;
}
.winner-chip.selected {
  background: #eef6ff;
  border-color: #cfe2ff;
  box-shadow: 0 6px 14px rgba(36, 99, 235, 0.12);
}
.winner-chip__name {
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.winner-chip__guess {
  min-width: 0;
  color: #475569;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Резервируем место под маркер, чтобы не было "прыжка" высоты при выборе */
.winner-chip__marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  /* фон и цвет по умолчанию прозрачные, чтобы занимать место */
  background: transparent;
  color: transparent;
  font-size: 12px;
  font-weight: 900;
  /* предотвращаем сжатие/расширение при появлении/исчезновении контента */
  flex: 0 0 22px;
  border: 1px solid transparent;
}

/* Когда выбран — подсвечиваем маркер без изменения размеров */
.winner-chip.selected .winner-chip__marker {
  background: #22c55e;
  color: #fff;
  border-color: #22c55e;
}
.winners-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.btn-primary.winners-confirm {
  background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%);
  color: #fff;
  border: none;
  padding: 10px 16px;
  border-radius: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
  box-shadow: 0 6px 14px rgba(59, 130, 246, 0.18);
}
.btn-primary.winners-confirm:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(59, 130, 246, 0.26);
}
.btn-primary.winners-confirm:disabled {
  opacity: 0.6;
  filter: grayscale(0.1);
  cursor: not-allowed;
}
.btn-secondary.winners-none {
  background: #f1f5f9;
  color: #334155;
  border: 1px solid #e2e8f0;
  padding: 10px 14px;
  border-radius: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.btn-secondary.winners-none:hover:not(:disabled) {
  background: #e9eef5;
  border-color: #dbe6f3;
}
.btn-secondary.winners-none:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.winners-wait .winners-answers {
  margin: 8px 0 0 0;
  padding-left: 18px;
  color: #475569;
}

/* Адаптив для winners */
@media (max-width: 640px) {
  .winner-chip {
    grid-template-columns: 1fr auto;
    grid-template-areas: "name marker" "guess guess";
    row-gap: 6px;
  }
  .winner-chip__name { grid-area: name; }
  .winner-chip__guess { grid-area: guess; white-space: normal; }
  .winner-chip__marker { grid-area: marker; }
  .winners-actions {
    flex-direction: column;
    align-items: stretch;
  }
  .btn-primary.winners-confirm,
  .btn-secondary.winners-none {
    width: 100%;
  }
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
.reconnect-info {
  background: #fff3cd;
  color: #7a5d00;
  border: 1px solid #ffe08a;
  padding: 10px 12px;
  border-radius: 10px;
  font-weight: 600;
}

/* остальной CSS ниже */
</style>
