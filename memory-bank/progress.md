# Progress — GameCenter

Обновлено: 06.08.2025

## Что уже сделано
- Инициализирован и актуализирован Memory Bank:
  - projectbrief.md — цели и критерии MVP.
  - productContext.md — ценность для пользователя и потоки.
  - systemPatterns.md — архитектурные и организационные паттерны.
  - techContext.md — стек, структура, соглашения.
  - activeContext.md — обновлен по ревизии types/game.ts и stores/gameStore.ts, зафиксированы механики и сеть.
- Реализация в репозитории:
  - Типизированный протокол сообщений в types/game.ts (BaseMessage, PROTOCOL_VERSION, дискриминируемый PeerMessage, makeMessage, расширенные payloads: discovery, mesh, migration, recovery, split-brain).
  - Сторы: gameStore — полноценная логика basic/advanced, фазы, консенсусы, round‑processing, восстановление сессии, миграция/восстановление хоста (secure/emergency), host discovery, mesh, выборы хоста; hostMigration.ts (присутствует), counter.ts.
  - Компоненты: MainMenu, Lobby, GameField.
  - Сервис: peerService (P2P/WebRTC абстракция).
  - Роутер: router/index.ts.
  - Тестовая инфраструктура: Vitest (unit), Playwright (e2e).

## Последние изменения

- UI:
  - Удален глобальный оверлей восстановления в src/App.vue (rehydration-overlay) — глобальной индикации переподключения больше нет.
  - В src/components/GameField.vue удалены все глобальные блоки reconnect-info из всех игровых фаз; в лобби внутри GameField контент показывается только при connected.
  - В src/components/Lobby.vue сохранен локальный баннер reconnect-banner — Pop-индикатор отображается только в лобби и в самой игре при переподключении; в главном меню Pop отсутствует.
- Документация: обновлен memory-bank/activeContext.md, зафиксировано новое поведение индикации переподключения (только Lobby и GameField).
- Состояние сети/дискавери: подтверждены паттерны из systemPatterns.md (health‑check кандидатов, blacklist, строгий критерий restore).
- Debug‑флаг:
  - Добавлена утилита src/utils/debug.ts с isDebugEnabled(), enableDebug(), disableDebug().
  - В src/stores/gameStore.ts добавлен и экспортирован computed isDebug = computed(() => isDebugEnabled()).
  - Компоненты могут условно отображать отладочный UI: v-if="game.isDebug".

## Что осталось (MVP дорожная карта)
- Интегрировать флаг отладки в нужные компоненты (панели/кнопки/логи) через v-if="game.isDebug".
- Добавить unit‑тесты на utils/debug.ts (обработка '0'/'false'/'off', пустые/непустые значения).
- (Опционально) E2E сценарий проверки условной видимости debug‑элементов при установленном __app_debug.
1) Тесты:
   - Unit для gameStore: basic/advanced переходы фаз, консенсус nextRound, начисления очков, подсветка, восстановление.
   - Unit/интеграционные для миграции и восстановления: secure voting flow, deterministic fallback (min id только среди «живых»), recovery announcement/new_host_id, строгий критерий успешного restore.
   - E2E: 2 клиента, старт, дисконнект/перезагрузка хоста → health‑checked discovery → либо восстановление к тому же hostId, либо детерминированная переизбрация → продолжение без split‑brain.
2) Протокол/peerService:
   - Вынести health‑check кандидатов и blacklist в peerService; выровнять API (getPeer/hasConnection/connectToPeer/cleanupInactiveConnections).
   - Уточнить retry/timeout/backoff, идемпотентные resync‑механики, audit на reentrancy discovery/handlers.
3) Навигационный флоу:
   - Гварды и UX‑состояния: connecting/discovering/restoring/migration; убрать ложные «успешно восстановлено» до state sync.
4) UI/UX:
   - Индикаторы статусов (connecting/connected, discovering/restoring, migration in progress), прогрессы голосов/ставок, доступность действий по ролям/фазам.

## Риски/блокеры
- P2P в гетерогенных сетях (NAT/ICE) может приводить к флаки‑поведению.
- Split‑brain и консистентность состояния при миграции/восстановлении.
- Флаки e2e без стабильных таймингов/моков.

## Метрики статуса
- [x] Удалены лишние reconnect‑сообщения в UI (GameField) — только popup.
- [x] Глобальная индикация переподключения убрана из App.vue.
- [x] Локальный Pop/баннер виден только в Lobby и GameField при переподключении; в MainMenu отсутствует.
- [x] Глобальный debug‑флаг доступен через store.isDebug и управляется localStorage (__app_debug).
- [x] Протокол сообщений типизирован и используется в stores.
- [x] Исправлены сценарии зацикливания на недоступном hostId (health‑check + blacklist).
- [x] Статус восстановления помечается только после валидного state sync.
- [ ] Машина состояний покрывает основные переходы и миграцию тестами.
- [ ] Unit‑тесты на критичные переходы проходят.
- [ ] e2e сценарий миграции/восстановления хоста стабилен.
- [ ] UI показывает статусы соединения/реконнектов/миграции.

## Следующие конкретные действия
- Сформировать тест‑кейсы (Vitest) для флоу basic/advanced и миграции/восстановления; подготовить фикстуры gameState.
- Перенести health‑check/blacklist/discovery в peerService и покрыть unit‑тестами.
- Определить тайминги/моки для стабильных e2e (Playwright) сценариев: reload хоста, потеря хоста, переизбрация, восстановление.
- Провести ревизию peerService на предмет ретраев/таймаутов и идемпотентности sync/merge; добавить reentrancy guards.
