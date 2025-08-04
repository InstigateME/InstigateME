import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'MainMenu',
      component: () => import('@/components/MainMenu.vue')
    },
    {
      path: '/lobby/:hostId?',
      name: 'Lobby',
      component: () => import('@/components/Lobby.vue'),
      props: true
    },
    {
      path: '/game',
      name: 'Game',
      component: () => import('@/components/GameField.vue')
    }
  ],
})

export default router
