<script setup lang="ts">
import { onUnmounted, computed } from 'vue'
import { useGameStore } from '@/stores/gameStore'

const gameStore = useGameStore()

// Очистка соединений при закрытии приложения
onUnmounted(() => {
  gameStore.leaveRoom()
})

// UI-флаг "никогда не пустой экран": если идёт восстановление/подключение,
// отображаем поверх текущего интерфейса полупрозрачный оверлей без скрытия контента.
const uiConnecting = computed(() => gameStore.uiConnecting)

/* Debug-панель удалена по требованию: Pinia остается единственным источником правды */
</script>

<template>
  <div id="app">
    <RouterView />

    <div v-if="uiConnecting" class="rehydration-overlay" aria-live="polite">
      <div class="rehydration-card">
        <div class="spinner" aria-hidden="true"></div>
        <div class="title">Восстанавливаем соединение…</div>
      </div>
    </div>

    <!-- Debug-панель удалена по требованию -->
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  line-height: 1.6;
  color: #333;
  background: #f5f5f5;
}

#app {
  min-height: 100vh;
  position: relative;
}

/* Debug-панель и стили удалены по требованию */

/* Overlay для быстрой ре-гидрации: поверх интерфейса, без белого экрана */
.rehydration-overlay {
  position: fixed;
  inset: 0;
  background: rgba(245, 245, 245, 0.6);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.rehydration-card {
  background: #ffffff;
  border: 1px solid rgba(0,0,0,0.06);
  box-shadow: 0 4px 16px rgba(0,0,0,0.08);
  border-radius: 12px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  animation: fadeIn 160ms ease-in;
}

.rehydration-card .title {
  font-weight: 700;
  font-size: 15px;
  color: #222;
  margin-bottom: 2px;
}

.rehydration-card .subtitle {
  font-size: 12px;
  color: #666;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid #e5e7eb;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Глобальные стили для кнопок */
.btn {
  display: inline-block;
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s ease;
  user-select: none;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Анимации */
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Адаптивность */
@media (max-width: 768px) {
  body {
    font-size: 14px;
  }
}
</style>
