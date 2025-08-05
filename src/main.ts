import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
app.use(router)

// Автовосстановление сессии при загрузке приложения
import { useGameStore } from './stores/gameStore'
const gameStore = useGameStore(pinia)
gameStore.restoreSession().catch(() => {
  // Тихо игнорируем, если нечего восстанавливать
})

app.mount('#app')
