# Текущий план работ

Составлен 2026-06-11 по результатам ревью архитектуры и кода.
Сверен с кодом 2026-06-13 — все пункты 1–10 реализованы (см. ссылки на строки).
Статусы: `[ ]` — не начато, `[x]` — сделано.

## Forward-proofing схемы БД — закрыто в v1 baseline (2026-06-13)

Перед v1 миграции 0001–0014 схлопнуты в один `migrations/0001_initial_schema.sql` (prod-D1
пересоздаётся с нуля), и forward-proofing встроен прямо в baseline — в свежей схеме это бесплатно,
без table-rebuild/`lint-ok`. Подробности — `ARCHITECTURE.md` → «Schema evolution under additive-only
migrations».

- **[x] A. `incidents.alert_rule_id` теперь nullable** (+ `acknowledged_at`/`acknowledged_by`/
  `created_by`, таблица `incident_updates`) — под ручные инциденты и acknowledge/timeline.
- **[x] B. Сняты `CHECK`-enum'ы с растущих полей** (`monitors.type`, `alert_rules.condition`/
  `severity`, `incidents.severity`, `notification_channels.type`) — валидация на входе через
  `config.schema.json`.
- **[x] C. Generic-метрики под OpenMetrics** — `metric_samples` + `metric_sample_hourly`/`_daily`.
- **[x] D. Maintenance windows** — `maintenance_windows` + `maintenance_window_monitors` (реализованы
  фичей; во время окна мониторы не пробятся).
- Также заложены **группы/компоненты** (`monitor_groups` + `monitors.group_id`) и **push-heartbeat**
  (`monitors.heartbeat_token`). Все фич-таблицы/столбцы инертны до реализации соответствующего кода.
- **Multi-region** осознанно НЕ заложен (потребовал бы региональное измерение в PK
  `monitor_state`/`uptime_*` = rebuild) — отдельной миграцией, если/когда понадобится.


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
