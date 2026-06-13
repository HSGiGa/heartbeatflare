# Текущий план работ

Составлен 2026-06-11 по результатам ревью архитектуры и кода.
Сверен с кодом 2026-06-13 — все пункты 1–10 реализованы (см. ссылки на строки).
Статусы: `[ ]` — не начато, `[x]` — сделано.

## Forward-proofing схемы БД (новое, открыто — по итогам аудита 2026-06-13)

Контекст: миграции строго additive-only (`npm run migration:lint`). Каждый
`CHECK (... IN (...))`-enum и каждый `NOT NULL`-столбец — дверь в одну сторону: изменение
требует полного rebuild таблицы под `PRAGMA foreign_keys=OFF` (как уже было в
`0002_remove_ping_type.sql`). Целевые фичи на радаре: **maintenance windows** и
**openmetrics/произвольные метрики**. Tenancy — вне скоупа (single-account self-host).
Подробности и обоснование — в `ARCHITECTURE.md` → «Schema evolution under additive-only
migrations». Пункт D (maintenance) реализован миграцией `0014_maintenance_windows.sql`;
A–C остаются открытыми (потребуют table-rebuild по образцу `0002`, делать когда понадобятся).

### [ ] A. Снять `NOT NULL` с `incidents.alert_rule_id`

Сейчас `alert_rule_id TEXT NOT NULL REFERENCES alert_rules(id)`. Блокирует инциденты без
правила: maintenance-инциденты и ручные пометки. Снять `NOT NULL` в SQLite — только rebuild;
дешевле сейчас (история мала), чем потом. Сделать в `0014` по образцу `0002`.

### [ ] B. Ослабить `CHECK`-enum'ы на растущих полях

`monitors.type`, `notification_channels.type`, `alert_rules.condition`, `severity` (и др.) —
убрать `CHECK (... IN (...))`, оставив валидацию на уровне `config.schema.json` (она уже есть на
входе). Тогда новые типы мониторов/каналов/условий не требуют rebuild. Делать в том же `0014`.

### [ ] C. Generic-метрики под OpenMetrics

`metric_series` имеет фиксированные столбцы (`latency_ms`, `response_time_ms`, `tcp_connect_ms`).
Для скрейпа произвольных именованных метрик (Phase 2) ввести
`metric_samples(monitor_id, metric_name, value, recorded_at, labels)` + аналог hourly/daily
агрегации и retention. Спроектировать ДО реализации openmetrics-скрейпа.

### [x] D. Maintenance windows — сделано (2026-06-13)

Реализовано фичей status-page (миграция `0014_maintenance_windows.sql`): таблицы
`maintenance_windows` + `maintenance_window_monitors` (пустой набор мониторов = глобальное окно).
Объявляются в `config.yaml` (секция `maintenance:`) → импорт в D1. Поведение «skip probing»:
во время активного окна планировщик (`src/scheduler.ts`) не пробит затронутые мониторы — нет
пробы → нет инцидента, uptime не страдает; эскалации по ним подавляются. Статус-страница
показывает баннер и метку «Maintenance», Atom-feed включает окна. Пункты A–C не понадобились
(окна реализованы без incident-ов и без rebuild — миграция чисто additive).

> Группы/компоненты, incident-timeline, ack/assignee, подписчики статус-страницы — вне текущего
> скоупа; все добавляются additively позже без боли (зафиксировано в `ARCHITECTURE.md`, Roadmap).

---

## Критично (сделано)

### [x] 1. Down-алерты подавляются активным SSL-инцидентом — сделано (2026-06-13 verified)

Исправлено в `src/alerts.ts`: `evaluateAlerts` гейтит по `activeByClass` (per-class —
connectivity vs `ssl_expiry`) вместо глобального `active_incident_id`. Открытый SSL-warning
больше не подавляет down-инцидент; оба класса живут независимыми жизненными циклами.

### [x] 2. Приватные мониторы не должны утекать при отключённом auth — сделано

`src/routes.ts:226` — `showAll = session !== null` (fail-closed). Отсутствие/выключенный
`auth_config` = «только публичное». В SQL-запросах фильтр `AND m.visibility = 'public'` для
неаутентифицированных; `scrape_url`/правила/usage скрыты (`handleStatusApi`, `fetchMonitorRows`).

### [x] 3. Удалить реализацию /beat (heartbeat-мониторинг) — сделано

Роут `POST /beat` и `handleHeartbeat` удалены (`src/routes.ts` не содержит /beat); тип
`heartbeat` убран из рантайма (`MonitorRow` = `http|tcp|dns`). Push-heartbeat перенесён в
Phase 2 (`ARCHITECTURE.md` Roadmap).

### [x] 4. Ретеншн: monitor_executions, incidents, notification_deliveries — сделано

`src/scheduler.ts` (ежедневно ~04:30 UTC): `monitor_executions` > 48h, resolved `incidents` >
120 дней, `metric_series` > 7 дней, `uptime_hourly` > 48h. `notification_deliveries` чистятся
каскадно через `ON DELETE CASCADE` по `incident_id`. Открытые инциденты не удаляются.

### [x] 5. Retry уведомлений — сделано

`src/queue.ts:50-55` — при неуспехе доставки во ВСЕ каналы `msg.retry()` (иначе `msg.ack()`,
чтобы не дублировать успешные); реальный номер попытки `msg.attempts` передаётся в
`notification_deliveries`. `max_retries` настроен в сгенерированном `wrangler.jsonc`.

### [x] 6. Планировщик: голодание при >15 due-мониторов — сделано

`src/scheduler.ts:126` — `dueExternal.sort(... last_check_at ASC, NULLS first)` перед
`slice(0, MAX_CHECKS_PER_RUN)`. Никогда-непроверенные идут первыми; остальные ротируются по тикам.

### [x] 7. Атомарность открытия/закрытия инцидентов и счётчиков — сделано

`src/alerts.ts` — INSERT инцидента + UPDATE `monitor_state` идут одним `env.DB.batch()`;
уведомление в очередь шлётся только после коммита батча. Счётчики `consecutive_*` считаются в JS,
но это безопасно: планировщик — единственный писатель (one evaluation per monitor per tick,
задокументировано в коде).

## Важно (сделано)

### [x] 8. /auth/logout: 500 при отключённом auth — сделано

`src/routes.ts:200-202` — редиректы используют абсолютный URL (`origin + '/public'`);
при наличии auth — `handleLogout` чистит cookie.

### [x] 9. Edge-кэш для /public — сделано

`src/routes.ts` — `withPublicEdgeCache` (Cache API `caches.default`, namespaced ключ) +
`Cache-Control: public, max-age=60` для неаутентифицированных `/public`, `/api/status`,
`/api/history`. Аутентифицированные ответы — `no-store`.

## Средне (сделано)

### [x] 10. Актуализировать ARCHITECTURE.md — сделано

`ARCHITECTURE.md` приведён к реальности: один Worker (три входа), Queues для уведомлений,
типы `http|tcp|dns` (+ openmetrics Phase 2), path-роутинг, подстановка `${VAR}`, ретеншн
48h/120d/7d, fail-closed. Дополнен разделом про эволюцию схемы под additive-only (по аудиту
2026-06-13).

## Выполнено (ранее)

### [x] 11. import-config: INSERT OR REPLACE каскадно стирает runtime-данные

Исправлено 2026-06-11: `INSERT OR REPLACE` заменён на `INSERT ... ON CONFLICT(id) DO UPDATE SET`
для `monitors`, `alert_rules`, `notification_channels` — апдейт на месте, runtime-данные и
`created_at` сохраняются. Импорт идемпотентен; CI на `main` больше не уничтожает production-данные.
