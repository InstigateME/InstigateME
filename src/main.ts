import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { persistedState } from '@/plugins/persistedState'

import App from './App.vue'
import router from './router'
import { storageSafe } from './utils/storageSafe'

const app = createApp(App)

const pinia = createPinia()
pinia.use(persistedState())
app.use(pinia)
app.use(router)

// Глобальная гидратация Pinia из системы хранения проекта (storageSafe)
// Согласуемся с существующей схемой ключей (__app_ns:global:piniaState)
try {
  const parsed = storageSafe.nsGet<Record<string, any>>('global', 'piniaState', null)
  if (parsed && typeof parsed === 'object') {
    Object.assign(pinia.state.value, parsed)
  }
} catch {
  // ignore invalid / denied
}

// Глобальный персист всего состояния Pinia через watch на pinia.state.
// Сохраняем через storageSafe под согласованный ключ namespace 'global' и key 'piniaState'.
// Новая система хранения приоритетна и заменяет прямые обращения к localStorage.
import { watch } from 'vue'
watch(
  pinia.state,
  (state) => {
    try {
      // nsSet хранит «сырое» строковое значение; нам нужен JSON-снимок.
      storageSafe.nsSet('global', 'piniaState', JSON.stringify(state))
    } catch {
      // ignore quota/denied
    }
  },
  { deep: true },
)

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
