# Progress — GameCenter

Обновлено: 05.08.2025

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

## Что осталось (MVP дорожная карта)
1) Тесты:
   - Unit для gameStore: basic/advanced переходы фаз, консенсус nextRound, начисления очков, подсветка, восстановление.
   - Unit/интеграционные для миграции: secure voting flow, deterministic fallback, recovery announcement.
   - E2E: 2 клиента, старт, дисконнект хоста → миграция → продолжение.
2) Протокол/peerService:
   - Уточнить retry/timeout/backoff политики, обработку ошибок, идемпотентные ресинк‑механики.
   - Проверить и доработать merge сетей (NetworkMerge*), правила разрешения конфликтов.
3) Навигационный флоу:
   - Гварды и UX-переходы Lobby → GameField → выход/возврат, отображение статусов connecting/discovering/restoring/migration.
4) UI/UX:
   - Индикаторы статусов (connecting/connected, discovering/restoring, migration in progress), прогрессы голосов/ставок, видимость кнопок по ролям/фазам.

## Риски/блокеры
- P2P в гетерогенных сетях (NAT/ICE) может приводить к флаки‑поведению.
- Split‑brain и консистентность состояния при миграции/восстановлении.
- Флаки e2e без стабильных таймингов/моков.

## Метрики статуса
- [x] Протокол сообщений типизирован и используется в stores.
- [ ] Машина состояний покрывает основные переходы и миграцию тестами.
- [ ] Unit‑тесты на критичные переходы проходят.
- [ ] e2e сценарий миграции хоста стабилен.
- [ ] UI показывает статусы соединения/реконнектов/миграции.

## Следующие конкретные действия
- Сформировать тест‑кейсы (Vitest) для флоу basic/advanced и миграции; подготовить фикстуры gameState.
- Определить тайминги/моки для стабильных e2e (Playwright) и сценарий миграции.
- Провести ревизию peerService на предмет ретраев/таймаутов и идемпотентности sync/merge.
