<template>
  <div class="main-menu">
    <div class="container">
      <h1 class="title">Провокатор</h1>
      <p class="subtitle">Многопользовательская карточная игра</p>

      <div class="form-section">
        <div class="input-group">
          <label for="nickname">Ваш никнейм:</label>
          <input
            id="nickname"
            v-model="gameStore.myNickname"
            type="text"
            placeholder="Введите никнейм"
            maxlength="20"
            @keyup.enter="createRoom"
          />
        </div>

        <button
          class="btn btn-primary btn-large"
          @click="createRoom"
          :disabled="!gameStore.myNickname.trim() || gameStore.connectionStatus === 'connecting'"
        >
          {{ gameStore.connectionStatus === 'connecting' ? 'Создание...' : 'Создать комнату' }}
        </button>
      </div>

      <div class="divider">
        <span>или</span>
      </div>

      <div class="form-section">
        <div class="input-group">
          <label for="roomId">ID комнаты:</label>
          <div class="input-with-button">
            <input
              id="roomId"
              v-model="joinRoomId"
              type="text"
              placeholder="Введите ID комнаты"
              @keyup.enter="joinRoom"
            />
          </div>
        </div>

        <button
          class="btn btn-secondary btn-medium"
          style="margin-bottom: 12px;"
          @click="pasteFromClipboard"
          :disabled="gameStore.connectionStatus === 'connecting'"
        >
          Вставить из буфера
        </button>
        <button
          class="btn btn-secondary btn-large"
          @click="joinRoom"
          :disabled="!gameStore.myNickname.trim() || !joinRoomId.trim() || gameStore.connectionStatus === 'connecting'"
        >
          {{ gameStore.connectionStatus === 'connecting' ? 'Подключение...' : 'Присоединиться' }}
        </button>
      </div>

      <div v-if="isRestoringSession" class="loading-message">
        <div class="spinner"></div>
        Восстановление сессии...
      </div>

      <div v-if="errorMessage" class="error-message">
        {{ errorMessage }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useGameStore } from '@/stores/gameStore'

const router = useRouter()
const route = useRoute()
const gameStore = useGameStore()

const joinRoomId = ref('')
const errorMessage = ref('')
const isRestoringSession = ref(false)

 // Проверяем, есть ли hostId в URL (переход по QR-коду) и сохраненная сессия
onMounted(async () => {
  // Единственное допустимое прямое обращение к localStorage — никнейм под ключом 'nickname'
  const savedNickname = localStorage.getItem('nickname')
  if (savedNickname) {
    gameStore.myNickname = savedNickname
  } else if (!gameStore.myNickname) {
    gameStore.myNickname = gameStore.generateDefaultNickname()
  }

  // Поддержка обоих вариантов: ?hostId=... и ?host=...
  const hostIdFromUrl = (route.query.hostId as string) || (route.query.host as string)
  if (hostIdFromUrl) {
    joinRoomId.value = hostIdFromUrl
  }

  // Проверяем наличие сохраненной сессии
  if (gameStore.hasActiveSession()) {
    try {
      isRestoringSession.value = true
      errorMessage.value = ''

      console.log('Found saved session, attempting to restore...')
      const restored = await gameStore.restoreSession()

      if (restored) {
        console.log('Session restored successfully, redirecting...')
        // Редирект строго по фазе: lobby -> /lobby, иначе -> /game
        const phase = gameStore.gameState.phase ?? (gameStore.gameState.gameStarted ? 'drawing_question' : 'lobby')
        if (phase === 'lobby' && !gameStore.gameState.gameStarted) {
          await router.push('/lobby')
        } else {
          await router.push('/game')
        }
      } else {
        console.log('Session restoration failed')
        errorMessage.value = 'Не удалось восстановить сессию. Создайте новую комнату.'
      }
    } catch (error) {
      console.error('Session restoration error:', error)
      errorMessage.value = 'Ошибка при восстановлении сессии. Создайте новую комнату.'
    } finally {
      isRestoringSession.value = false
    }
  }
})

const createRoom = async () => {
  if (!gameStore.myNickname.trim()) return

  try {
    errorMessage.value = ''
    const roomId = await gameStore.createRoom(gameStore.myNickname.trim())
    console.log('Room created:', roomId)
    await router.push('/lobby')
  } catch (error) {
    console.error('Failed to create room:', error)
    errorMessage.value = 'Не удалось создать комнату. Попробуйте еще раз.'
  }
}

const joinRoom = async () => {
  if (!gameStore.myNickname.trim() || !joinRoomId.value.trim()) return

  try {
    errorMessage.value = ''
    await gameStore.joinRoom(gameStore.myNickname.trim(), joinRoomId.value.trim())
    console.log('Joined room:', joinRoomId.value)
    await router.push('/lobby')
  } catch (error) {
    console.error('Failed to join room:', error)
    errorMessage.value = 'Не удалось подключиться к комнате. Проверьте ID комнаты.'
  }
}
const pasteFromClipboard = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      joinRoomId.value = text.trim();
      joinRoom();
    }
  } catch (error) {
    console.error('Failed to read clipboard:', error);
    errorMessage.value = 'Не удалось прочитать буфер обмена.';
  }
};
</script>

<style scoped>
.main-menu {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 20px;
}

.container {
  background: white;
  border-radius: 20px;
  padding: 40px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  width: 100%;
  max-width: 400px;
}

.title {
  text-align: center;
  color: #333;
  margin-bottom: 10px;
  font-size: 2.5rem;
  font-weight: bold;
}

.subtitle {
  text-align: center;
  color: #666;
  margin-bottom: 30px;
  font-size: 1rem;
}

.form-section {
  margin-bottom: 20px;
}

.input-group {
  margin-bottom: 15px;
}

.input-group label {
  display: block;
  margin-bottom: 8px;
  color: #333;
  font-weight: 500;
}

.input-group input {
  width: 100%;
  padding: 12px 16px;
  border: 2px solid #e1e5e9;
  border-radius: 10px;
  font-size: 16px;
  transition: border-color 0.3s ease;
  box-sizing: border-box;
}

.input-group input:focus {
  outline: none;
  border-color: #667eea;
}

.btn {
  width: 100%;
  padding: 12px 24px;
  border: none;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-sizing: border-box;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-large {
  padding: 16px 24px;
  font-size: 18px;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
}

.btn-secondary {
  background: linear-gradient(135deg, #4ecdc4 0%, #44a08d 100%);
  color: white;
}

.btn-secondary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 5px 15px rgba(78, 205, 196, 0.4);
}

.divider {
  text-align: center;
  margin: 30px 0;
  position: relative;
  color: #999;
}

.divider::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: #e1e5e9;
}

.divider span {
  background: white;
  padding: 0 15px;
  position: relative;
}

.loading-message {
  color: #667eea;
  text-align: center;
  margin-top: 15px;
  padding: 15px;
  background: #f8f9ff;
  border-radius: 8px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid #e1e5e9;
  border-top: 2px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.error-message {
  color: #e74c3c;
  text-align: center;
  margin-top: 15px;
  padding: 10px;
  background: #fdf2f2;
  border-radius: 8px;
  font-size: 14px;
}
.btn-small {
  padding: 8px 12px;
  font-size: 14px;
}

.btn-clipboard {
  background: linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%);
  color: white;
  margin-left: 10px;
}

.btn-clipboard:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 5px 15px rgba(255, 154, 158, 0.4);
}
.btn-icon {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  margin-left: 10px;
  font-size: 20px;
  color: #667eea;
  transition: color 0.3s ease, transform 0.3s ease;
}

.btn-icon:disabled {
  color: #ccc;
  cursor: not-allowed;
}

.btn-icon:hover:not(:disabled) {
  color: #764ba2;
  transform: scale(1.1);
}

.icon-clipboard::before {
  content: '\1F4CB'; /* Unicode for clipboard icon */
  display: inline-block;
}
.input-with-button {
  display: flex;
  align-items: center;
}

.input-with-button input {
  flex: 1;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.input-with-button .btn-icon {
  border: 2px solid #e1e5e9;
  border-left: none;
  border-radius: 0 10px 10px 0;
  margin-left: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: white;
  color: #667eea;
  transition: background-color 0.3s ease, color 0.3s ease;
}

.input-with-button .btn-icon:hover:not(:disabled) {
  background: #f0f4ff;
  color: #764ba2;
}
</style>
