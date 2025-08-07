import { defineStore } from 'pinia'

export const useCounterStore = defineStore('counter', {
  state: () => ({
    count: 0,
  }),
  actions: {
    increment() {
      this.count++
    },
    decrement() {
      this.count--
    },
    reset() {
      this.count = 0
    },
  },
  // Demo: persist only 'count' with debounce and cross-tab sync
  persist: {
    key: 'counter',
    version: 1,
    paths: ['count'],
    debounceMs: 200,
    syncTabs: true,
  },
})
