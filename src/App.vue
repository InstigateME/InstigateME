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
