import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { persistedState } from '@/plugins/persistedState'

import App from './App.vue'
import router from './router'

const app = createApp(App)

const pinia = createPinia()
pinia.use(persistedState())
app.use(pinia)
app.use(router)

// Автовосстановление сессии при загрузке приложения
import { useGameStore } from './stores/gameStore'

// Быстрое восстановление: сперва попытаться восстановить сессию,
// но не блокировать монтирование приложения.
// Если восстановление удастся — роутер-guard отправит на нужный экран.
const gameStore = useGameStore(pinia)
gameStore.restoreSession().catch(() => {
  /* ignore: нет сохранённой сессии */
})

app.mount('#app')
