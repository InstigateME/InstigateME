# Active Context — GameCenter

Обновлено: 05.08.2025

## Текущий фокус

- Актуализация Memory Bank по итогам ревизии src/types/game.ts и src/stores/gameStore.ts.
- Зафиксированы ключевые механики игры «Провокатор» (basic/advanced), раундность, фазы, и сетевой протокол.
- Подготовка к тестированию: выделение критичных переходов фаз и миграции хоста для unit/e2e.

## Недавние изменения

- В types/game.ts реализован типизированный протокол P2P сообщений:
  - Базовая форма BaseMessage с protocolVersion и meta.
  - Полный дискриминируемый юнион PeerMessage (join_request, game_state_update, light_up_request, start_game, heartbeat, request_game_state, ошибки, миграция, discovery, mesh, sync, выборы хоста и игровые сообщения).
  - Утилита makeMessage и PROTOCOL_VERSION = 1.
  - Расширенные полезные нагрузки для восстановления сети и split-brain.
- В gameStore.ts реализованы:
  - Двухрежимная логика basic/advanced с чередованием по раундам (TOTAL_ROUNDS = 16), вычислением currentMode, фазами и переходами.
  - Полный обработчик игрового флоу: drawCard, submitVote, submitBet, finishRoundHostOnly, advanced ветка (answering → guessing → selecting_winners → advanced_results).
  - Консенсусные проверки перед nextRound.
  - Подсветка игрока с безопасной обработкой litUpPlayerId.
  - Сессионный менеджмент (save/load/restore) и универсальное восстановление (universalHostDiscovery, restoreAsHost/Client).
  - Обработка отключения хоста, grace period и безопасная/детерминированная миграция (initiateHostMigration, participateInMigration, votes/consensus, becomeNewHostSecurely, finalizeHostMigration, becomeNewHostWithRecovery).
  - Mesh‑протокол (peer list, direct connection, state sync, host election) и host discovery.

## Текущее состояние кода (по структуре репо)

- Компоненты: MainMenu.vue, Lobby.vue, GameField.vue
- Сторы: gameStore.ts, hostMigration.ts, counter.ts
- Сервис: services/peerService.ts (P2P/WebRTC абстракция)
- Роутер: router/index.ts
- Типы: types/game.ts
- Тесты: Vitest (unit в src/__tests__), Playwright (e2e/)
- Конфиги: vite.config.ts, vitest.config.ts, playwright.config.ts, eslint.config.ts, .prettierrc.json

## Важные договорённости

- Мутации состояния идут через Pinia actions; состояние — единый источник правды.
- peerService инкапсулирует сетевую логику; сторы подписываются на его события.
- Типы сообщений и доменные структуры — в src/types/game.ts.
- Режим игры определяется чередованием раундов: currentMode — источник правды (gameState.gameMode синхронизируется из него).

## Риски и наблюдения

- P2P устойчивость: реконнекты, split‑brain, и миграция хоста критичны для UX.
- Нужно удерживать идемпотентность синхронизации состояния, особенно при восстановлении и merge сетей.
- Для e2e возможны нестабильности без моков/фикстур — учесть в планировании и ввести контролируемые тайминги.

## Ближайшие шаги (очерёдность)

1) Дополнить unit‑тестами gameStore:
   - Голосование/ставки и переходы фаз в basic.
   - advanced: выбор отвечающего, ответы, догадки, выбор победителей и начисление очков.
   - Консенсус перед nextRound.
2) Протестировать миграцию хоста:
   - Дет‑выбор, secure migration c голосами, emergency takeover, host recovery announcement.
   - Валидации токенов и player_id_updated поток.
3) Проверить/добавить гварды в роутере для стабильного Lobby → GameField и возврата.
4) Подготовить e2e: 2 клиента, старт, дисконнект хоста → миграция → продолжение.
5) В UI/UX добавить явные индикаторы статусов (connecting/connected, discovering/restoring, inProgress migration).

## Открытые решения (todo)

- Версионирование протокола и совместимость сообщений (расширение PROTOCOL_VERSION с маппингом).
- Политика ретраев/таймаутов/бэк‑оффов в peerService.
- Стратегия merge сетей (NetworkMergeRequest/Response) и правила разрешения конфликтов.

## Индикаторы готовности текущего этапа

- Типобезопасный протокол сообщений описан и используется.
- Сторы покрыты тестами на ключевые переходы и миграцию/восстановление.
- e2e демонстрирует стабильный сценарий с миграцией хоста и восстановлением сети.
