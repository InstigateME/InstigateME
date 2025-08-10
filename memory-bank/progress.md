# Progress — GameCenter

Обновлено: 10.08.2025

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

- **Memory bank и настройки обновлены** (коммит 36871f7):
  - Обновлены activeContext.md и progress.md с актуальными изменениями
  - Уточнен статус uncommitted изменений и документации  
  - Расширены разрешения в settings.local.json для git-команд и lint/build
- **Lobby robustness improvements** (коммит bbc3eef):
  - Очистка localStorage при создании/подключении к комнате (сохраняется nickname)
  - Улучшен responsive layout в GameField
  - Добавлены E2E тесты для смены nickname и переназначения хоста
- **CLAUDE.md и settings.local.json созданы** (предыдущие коммиты):
  - Добавлена полная документация для Claude Code с командами разработки, архитектурным обзором P2P мультиплеера, ключевыми паттернами (optimistic UI, host migration, state versioning)
  - Стратегией тестирования (E2E Playwright, unit Vitest) и структурой файлов
  - Настройки разрешений для E2E тестов в .claude/settings.local.json
- **Предыдущие улучшения**:
  - Optimistic UI с подтверждением доставки для голосования/ответов/догадок
  - Мьютексы для критических секций голосования/ставок
  - Улучшенное версионирование состояния и обработка ошибок
  - E2E тесты для 4-игрового асинхронного сценария
  - Single-monitor E2E режим с поддержкой кастомных размеров экрана

## Что осталось (MVP дорожная карта)
- Интегрировать флаг отладки в нужные компоненты (панели/кнопки/логи) через v-if="game.isDebug"
- Добавить unit‑тесты на utils/debug.ts (обработка '0'/'false'/'off', пустые/непустые значения)
- (Опционально) E2E сценарий проверки условной видимости debug‑элементов при установленном __app_debug
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
- [x] **CLAUDE.md документация создана и зафиксирована** — полное руководство для Claude Code (коммит 3d27ca9)
- [x] **Claude Code settings.local.json** — настройки разрешений для E2E тестов
- [x] **Lobby robustness** — улучшена устойчивость лобби с E2E тестами
- [x] **Optimistic UI** — реализовано с подтверждением доставки
- [x] **State versioning** — улучшено версионирование и обработка ошибок
- [x] **E2E testing** — добавлены тесты для 4-игровых сценариев
- [x] **Single-monitor support** — E2E тесты поддерживают разные размеры экранов
- [x] Удалены лишние reconnect‑сообщения в UI (GameField) — только popup
- [x] Глобальная индикация переподключения убрана из App.vue
- [x] Локальный Pop/баннер виден только в Lobby и GameField при переподключении
- [x] Глобальный debug‑флаг доступен через store.isDebug и управляется localStorage
- [x] Протокол сообщений типизирован и используется в stores
- [x] Исправлены сценарии зацикливания на недоступном hostId (health‑check + blacklist)
- [x] Статус восстановления помечается только после валидного state sync
- [x] **Memory bank обновлен** — актуализированы activeContext.md и progress.md по состоянию на 10.08.2025
- [ ] Машина состояний покрывает основные переходы и миграцию тестами
- [ ] Unit‑тесты на критичные переходы проходят
- [ ] e2e сценарий миграции/восстановления хоста стабилен
- [ ] UI показывает статусы соединения/реконнектов/миграции

## Следующие конкретные действия
- Сформировать тест‑кейсы (Vitest) для флоу basic/advanced и миграции/восстановления; подготовить фикстуры gameState.
- Перенести health‑check/blacklist/discovery в peerService и покрыть unit‑тестами.
- Определить тайминги/моки для стабильных e2e (Playwright) сценариев: reload хоста, потеря хоста, переизбрация, восстановление.
- Провести ревизию peerService на предмет ретраев/таймаутов и идемпотентности sync/merge; добавить reentrancy guards.
