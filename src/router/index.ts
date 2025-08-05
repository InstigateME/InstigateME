import { createRouter, createWebHistory } from 'vue-router'
import { useGameStore } from '@/stores/gameStore'

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

// Глобальный guard для восстановления и корректного роутинга после перезагрузки
router.beforeEach(async (to, from, next) => {
  const store = useGameStore()

  // Если сессия уже активна — направляем в актуальный экран
  const redirectAccordingToState = () => {
    const phase = (store.gameState.phase ?? 'lobby') as string
    const started = !!store.gameState.gameStarted
    if (phase !== 'lobby' && started) {
      if (to.name !== 'Game') {
        return next({ name: 'Game' })
      }
      return next()
    } else {
      if (to.name !== 'Lobby' && to.name !== 'JoinRedirect' && to.name !== 'MainMenu') {
        return next({ name: 'Lobby' })
      }
      return next()
    }
  }

  // Если уже подключены — просто направляем по состоянию
  if (store.connectionStatus === 'connected') {
    return redirectAccordingToState()
  }

  // Если не подключены, но есть сохраненная сессия — пробуем восстановить
  if (store.hasActiveSession()) {
    try {
      const restored = await store.restoreSession()
      if (restored) {
        return redirectAccordingToState()
      }
    } catch {
      // проваливаемся в обычный поток
    }
  }

  // Нет активной сессии — разрешаем стандартную навигацию
  return next()
})

/**
 * Guard: при наличии активной сессии и восстановлении соединения
 * не позволяем "проваливаться" в лобби, если сохраненная фаза не 'lobby'.
 * Это удерживает UI на экране игры до прихода свежего состояния от хоста.
 */
router.beforeEach(async (to) => {
  try {
    const store = useGameStore()

    // Если уже есть активная сессия, а соединение в процессе восстановления
    if (store.hasActiveSession() && store.connectionStatus === 'connecting') {
      const phase = store.gameState.phase ?? (store.gameState.gameStarted ? 'drawing_question' : 'lobby')
      if (phase !== 'lobby') {
        // Удерживаем на экране игры
        if (to.name !== 'Game') {
          return { name: 'Game' }
        }
      }
    }

    // Если подключены и игра шла — прямой переход на Game при попадании на корень
    if (to.name === 'MainMenu' && store.connectionStatus === 'connected') {
      const phase = store.gameState.phase ?? (store.gameState.gameStarted ? 'drawing_question' : 'lobby')
      if (phase !== 'lobby') {
        return { name: 'Game' }
      }
    }
  } catch {
    // Мягко игнорируем ошибки guard'а
  }
})

export default router
