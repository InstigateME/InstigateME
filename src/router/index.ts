import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/join',
      name: 'JoinRedirect',
      redirect: (to) => {
        const room = to.query.room as string | undefined
        if (room) {
          return { name: 'Lobby', params: { hostId: room } }
        }
        return { name: 'MainMenu' }
      }
    },
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
