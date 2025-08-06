# Tech Context — GameCenter

## Стек и версии (из репозитория)

- Vue 3 (Composition API), TypeScript
- Vite (dev/build), ESLint, Prettier
- Pinia (stores)
- Vue Router
- Vitest (unit), Playwright (e2e)
- P2P: PeerJS или WebRTC (через peerService.ts)
- Конфиги: vite.config.ts, vitest.config.ts, playwright.config.ts, eslint.config.ts, .prettierrc.json
- Проектные файлы: src/App.vue, src/main.ts, src/router/index.ts, src/components/*, src/stores/*,
  src/services/peerService.ts, src/types/game.ts

## Структура каталогов

- src/components: MainMenu.vue, Lobby.vue, GameField.vue
- src/stores: gameStore.ts, hostMigration.ts, counter.ts
- src/services: peerService.ts (абстракция P2P/WebRTC/Peer)
- src/types: game.ts (доменные типы)
- src/router: index.ts (маршруты)
- src/__tests__: unit тесты
- e2e: Playwright e2e тесты

## Сборка и запуск

- Дев‑сервер: Vite (npm run dev или аналогичная команда из package.json)
- Сборка: Vite build
- Тесты: Vitest (unit), Playwright (e2e)

## Технические соглашения

- TS строго для доменных структур.
- Pinia: actions — единственная точка мутации state.
- Сервисы изолируют интеграции (например, P2P).
- ESLint/Prettier: единый стиль кода.

### Локальное хранилище и debug‑флаг (обновлено 2025‑08‑06)
- Безопасный доступ к LocalStorage — через utils/storageSafe.ts (namespaced ключи "__app_ns:ns:key", TTL‑обёртки).
- Разрешённые прямые ключи:
  - 'nickname' — никнейм пользователя.
  - '__app_debug' — глобальный флаг отладки (для удобного ручного включения/выключения в консоли).
- Утилита utils/debug.ts:
  - isDebugEnabled(): true для любого непустого значения, кроме '0' | 'false' | 'off'; дополнительно проверяет "__app_ns::__app_debug" (совместимость).
  - enableDebug()/disableDebug(): переключатели флага.
- Интеграция: store.isDebug = computed(() => isDebugEnabled()) в src/stores/gameStore.ts; использовать в компонентах через v-if="game.isDebug".

## Ограничения/особенности

- P2P требует корректной инициализации/подписок и устойчивости к дисконнектам.
- Хранение состояния в store, синхронизация через сообщения.
- В e2e могут понадобиться мок‑сервисы/фикстуры для стабильности.

## Зависящие внешние сервисы

- P2P/PeerJS или WebRTC‑провайдер (реализация скрыта за peerService.ts).
- Нет выделенного бекенда в MVP.
