import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

// Возвращаемся к setup-стилю, а persist выносим во второй аргумент options, который допускает произвольные поля
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  const doubleCount = computed(() => count.value * 2)
  function increment() {
    count.value++
  }

  return { count, doubleCount, increment }
}, {
  // произвольные опции, читаемые нашим плагином persistedState
  // тип DefineSetupStoreOptions допускает расширение, не вызывая TS-ошибок
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - пользовательское поле для плагина
  persist: {
    key: 'counter',
    version: 1,
    paths: ['count'],
    debounceMs: 200,
    syncTabs: true,
  },
})
