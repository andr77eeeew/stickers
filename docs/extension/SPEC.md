# Спецификация расширения Sticker Workspace Capture

Состояние: 27 сентября 2026 года, этап E2. Документ — источник истины для текстов статусов; этап E5 дополнит его визуальными правилами.

## 1. Подключение

1. Dashboard → **Health → Capture extension → Connect extension**. Сервер создаёт токен (32 случайных байта, base64url) и сохраняет его в `output/.ingest-token` (права 0600; `output/` не в Git; файл не входит в archive snapshot).
2. Токен показывается только по запросу (`Show token`) и никогда не передаётся в `/api/status` или WebSocket.
3. Пользователь вставляет токен в popup (**Connection token**) → **Save and reconnect**.
4. `INGEST_TOKEN` в `.env` имеет приоритет: пока он задан, dashboard не создаёт и не удаляет токен, а только показывает его по запросу.
5. **Disconnect** удаляет файл токена; расширение получает `401 INGEST_DISABLED` и показывает `Capture disabled on server`. Библиотека не меняется.
6. Расширение само токен больше не создаёт; генерация для `.env` осталась в свёрнутом разделе popup `Advanced`.

| Эндпоинт | Доступ | Назначение |
| --- | --- | --- |
| `POST /api/extension/pair` | dashboard session | Создать или заменить токен, вернуть его |
| `POST /api/extension/token` | dashboard session | Показать текущий токен (`404 NOT_PAIRED`, если его нет) |
| `POST /api/extension/unpair` | dashboard session | Удалить токен (`409 ENV_TOKEN` при токене из `.env`) |
| `POST /api/extension/heartbeat` | Bearer + origin расширения | Состояние слушателя, счётчики очереди, версия |

## 2. Heartbeat

- Расширение отправляет heartbeat только на loopback и только при наличии токена: при запуске, при смене состояния слушателя, закрытии DevTools, включении/выключении захвата, после обработки очереди (не чаще раза в 2 с при изменениях) и не реже раза в 20 с, пока идут сигналы DevTools; периодический alarm — раз в минуту.
- Тело: `listenerState`, `queue { count, blocked, paused }`, `pausedReason`, `version`. Никаких URL, байтов или данных страницы. Сервер отвергает неизвестный `listenerState` (400) и обрезает счётчики.
- Сервер считает расширение на связи 45 с после последнего heartbeat и сам сообщает dashboard, когда связь пропала.
- Ответ 401/5xx на heartbeat сразу меняет состояние сервера в popup (`Token rejected` и т. д.) — ещё до первого захвата.

## 3. Словарь статусов

Один набор строк для popup, панели DevTools и dashboard. Строки слушателя в `extension/shared/statusText.js` и `frontend/src/lib/captureModel.js` сверяются тестом `test/capture-model.test.js`.

### Слушатель (знает только расширение)

| Состояние | Текст | Кратко в шапке dashboard | Тон |
| --- | --- | --- | --- |
| `off` | Capture off | Capture off | pending |
| `closed` | DevTools not open | DevTools closed | pending |
| `other_site` | DevTools on another site | Other site | pending |
| `watching_unconfirmed` | DevTools open, site not confirmed | DevTools open | pending |
| `watching` | Watching TikTok tab | Watching | ok |

Dashboard показывает состояние слушателя только при свежем heartbeat. Без него — прежние честные `Awaiting DevTools` / `Last asset accepted` с пояснением «No signal from the extension». Слово `Listening` нигде не используется.

### Локальный сервер (popup, панель)

| Состояние | Текст | Тон |
| --- | --- | --- |
| `online` | Online | ok |
| `offline` | Offline | problem |
| `unauthorized` | Token rejected | problem |
| `capture_disabled` | Capture disabled on server | problem |
| `configuration_required` | Setup required | pending |
| `server_error` | Server error | problem |
| `unknown` | Not checked | pending |

### Лента сессии (панель DevTools)

| Состояние | Текст | Тон |
| --- | --- | --- |
| `new` | Added to library | ok |
| `duplicate` | Already in library | ok |
| `queued` | Delivering… (или `Delivering · <причина>`) | pending |
| `held` | Held: <причина> | problem |
| `rejected` | Rejected: <причина> | problem |
| `discarded` | Discarded | pending |

Итог «Capture from Network log»: `Found N sticker responses: X sent to the library, Y already in library, …`; без стикеров — объяснение, что журнал содержит только запросы с момента открытия DevTools и что перезагружать чат не нужно.

### Предупреждения о темпе и безопасности

Расширение вычисляет предупреждения и передаёт dashboard только коды и числа; тексты в `statusText.js` и `captureModel.js` совпадают (тест `test/extension/pacing.test.js`). Порядок — от самого серьёзного.

| Код | Условие | Тон | Текст |
| --- | --- | --- | --- |
| `challenge` | ресурс с `captcha` в адресе или хост `verification…` на вкладке TikTok, 30 мин | problem | TikTok showed a verification check. Capture was turned off: close DevTools and use TikTok normally for a while. |
| `session_limit` | бюджет сервера исчерпан | problem | Session limit reached. Captures are kept; after a break, start a new session in the dashboard. |
| `cache_disabled` | запрос стикера с `no-cache`, 10 мин | problem | “Disable cache” or a hard reload is on: every sticker is downloaded again. Turn it off in the DevTools Network panel. |
| `session_near_limit` | ≥ 80 % захватов или времени бюджета | pending | Session: N of M captures, X of Y min. Plan a break soon. |
| `frequent_navigation` | ≥ 3 загрузки вкладки TikTok за 10 мин | pending | The TikTok tab reloaded N times in 10 min. Reloading to capture again adds traffic. |
| `fast_capture` | ≥ 12 новых стикеров за 2 мин | pending | N new stickers in 2 min. Scroll at a normal pace: fast bulk loading looks unlike normal use. |

Только `challenge` меняет поведение: выключает захват. Сигналы от одного источника отправляются не чаще раза в 30 с; разбор журнала Network сигналов не отправляет.

Сессия: `N of M captures · X of Y min`, до первого нового стикера — `0 of M captures · starts with the first new sticker`, после исчерпания — `Session limit reached`. Кнопка в dashboard — **Start new session**.

### Очередь

`Empty` (ok) · `N delivering` (pending) · `N held: budget paused` (pending) · `N (M blocked)` (problem).

### Захват в dashboard (порядок приоритета)

1. Нет токена → `Manual import`, кнопка `Connect extension`.
2. Предупреждение `challenge` → `Verification check`.
3. Сессия исчерпана → `Session limit`.
4. Ошибка доставки на сервере → `Delivery failed`.
5. Свежий heartbeat → `Extension · <текст слушателя>`, «Last signal N s ago»; задержанные захваты или предупреждение `problem` делают тон `problem`, прочие предупреждения — `pending`.
6. Иначе → `Last asset accepted` или `Awaiting DevTools` + «No signal from the extension».

В шапке на ширине < 1024 px префикс `Local ·` скрывается, подпись обрезается многоточием (128 px, < 760 px — 100 px); полный текст — в popover.

### Шапка popup и панели (порядок приоритета)

`StatusText.describeOverall` — та же логика, что у dashboard, но расширение знает больше (токен, сервер, очередь):

1. Нет токена → `Not connected` (pending); настройки popup раскрываются как шаг **Connect**.
2. Проблема сервера → `Server offline`, `Token rejected`, `Server not connected`, `Server error` (problem).
3. `challenge` → `Verification check` (problem).
4. Захват выключен → `Capture off` (pending).
5. Сессия исчерпана → `Session limit` (problem).
6. Заблокированные захваты → `Delivery failed` (problem).
7. Иначе короткий текст слушателя, как в dashboard (`Watching`, `DevTools closed`, `Other site`, `DevTools open`); тон повышают приостановленные захваты и предупреждения.

## 4. Оформление (E5)

- Токены — `extension/shared/tokens.css`: светлые значения из `docs/redesign/stage1/tokens.json` под именами переменных dashboard; тест `test/extension/design.test.js` сверяет их с `tokens.json` и `frontend/src/index.css`.
- Popup всегда светлый, ширина 360 px. Панель DevTools следует `chrome.devtools.panels.themeName` (`panelTheme.js` ставит `data-theme` до первой отрисовки); тёмная палитра производная, контраст текста ≥ 4.5:1 на всех фонах проверяет тот же тест.
- Компоненты (`shared/ui.css`) повторяют dashboard: brand mark, `status-pill` с точкой, кнопки `btn`/`btn-primary`/`btn-danger`, строки статуса `check-list`, `inline-alert` для предупреждений, переключатель `role="switch"`, focus-ring `#B8A7F5` 3 px.
- Иконки — outline lucide (ISC), инлайн через `shared/icons.js`; значок расширения 16/32/48/128 рисует `scripts/render-extension-icons.js`. Цвета badge — токены `accent`, `danger`, `warning`, `textSecondary`.
- `aria-live` только у итогов: pill статуса (`role="status"`), сообщение popup, итог разбора журнала Network. `prefers-reduced-motion` отключает переходы.
