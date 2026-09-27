# Ручная приёмка Sticker Workspace Capture 3.0.0

Автоматические проверки (E6) закрывают логику, сервер и вёрстку. Этот чек-лист подтверждает то, что можно увидеть только в настоящем Chrome на настоящей вкладке TikTok. Займёт 20–30 минут.

**Правила:**
- только тестовый аккаунт, который не жалко потерять;
- DevTools — отдельным окном;
- обычный темп;
- проверку TikTok (CAPTCHA) не провоцировать;
- не копировать в отчёт токен, cookie и адреса с `x-signature` или другими параметрами.

## 0. Подготовка

1. Сервер запущен (`npm start`), dashboard открыт на `http://127.0.0.1:3001`.
2. `chrome://extensions` → Developer mode → **Load unpacked** → папка `extension/` (или кнопка перезагрузки на карточке уже установленного расширения).
3. Dashboard → **Health → Capture extension** → **Connect extension** → скопировать токен.

## 1. Установка и подключение

| # | Действие | Ожидаемый результат |
| --- | --- | --- |
| 1.1 | Посмотреть карточку в `chrome://extensions` | Имя «Sticker Workspace Capture», версия 3.0.0, значок — белые звёзды на тёмном квадрате, кнопки **Errors** нет |
| 1.2 | **Details → Site access** | Только `127.0.0.1:3001` и `localhost:3001` |
| 1.3 | Открыть popup | Светлый, в шапке pill `Not connected`, раскрыт блок **Connect to Sticker Workspace** |
| 1.4 | Вставить токен → **Connect** | Сообщение `Connected to the local server.`, блок свернулся в **Settings**, Local server `Online` |
| 1.5 | Dashboard, pill статуса | Меняется с `Manual` на состояние расширения (например `Capture off`) |

## 2. Тема панели

| # | Действие | Ожидаемый результат |
| --- | --- | --- |
| 2.1 | DevTools → Settings → Preferences → Appearance → Theme: **Dark**, переоткрыть DevTools, вкладка **Sticker Capture** | Панель тёмная, текст читается |
| 2.2 | Theme: **Light** | Панель светлая |
| 2.3 | Theme: **System preference** при тёмной теме Windows | Записать, какая получилась панель (открытый вопрос E5) |

## 3. Захват

| # | Действие | Ожидаемый результат |
| --- | --- | --- |
| 3.1 | Включить **Capture from TikTok DMs**. Открыть TikTok Messages, затем DevTools на этой вкладке | Popup: DevTools `Watching TikTok tab` (не `DevTools open, site not confirmed`) — так подтверждается `getResources` |
| 3.2 | Открыть чат со **статическим** стикером | Панель: карточка `Added to library` с миниатюрой; в dashboard стикер появился; **Open in library** открывает его |
| 3.3 | То же для **анимированного** стикера | То же; в библиотеке стикер анимирован |
| 3.4 | Снова открыть тот же чат | `Already in library`, повторной отправки нет |
| 3.5 | Выключить захват, открыть другой чат со стикером, включить захват, в панели **Capture from Network log** | Итог `Found N sticker response(s): … sent to the library` |
| 3.6 | Переключить DevTools на вкладку другого сайта | Popup: `DevTools on another site` |

## 4. Нет лишних запросов

| # | Действие | Ожидаемый результат |
| --- | --- | --- |
| 4.1 | `chrome://extensions` → карточка → **Inspect views: service worker** → Network, затем повторить 3.2 | Только запросы к `127.0.0.1:3001` (`/api/ingest`, `/api/extension/heartbeat`, `/api/status`) |
| 4.2 | В DevTools вкладки TikTok, Network, фильтр `sticker` | Каждый стикер загружен один раз; в колонке Initiator нет расширения |
| 4.3 | Панель **Sticker Capture** → Network log | Запросов к TikTok нет (панель читает только уже записанные ответы) |

## 5. Сигналы безопасности

| # | Действие | Ожидаемый результат |
| --- | --- | --- |
| 5.1 | Network → включить **Disable cache**, открыть **один** новый стикер | Панель, Pacing: предупреждение `“Disable cache” or a hard reload is on…`; в dashboard — оно же. Затем выключить **Disable cache** (подтверждает гипотезу E4 о `no-cache`) |
| 5.2 | Если TikTok сам показал проверку | Захват выключился, pill `Verification check`. Записать только хост и путь ресурса проверки из Network, без параметров |
| 5.3 | Не делать | Частые перезагрузки и быстрый скролл ради предупреждений — это покрыто тестами |

## 6. Сессия (необязательно)

С `SESSION_MAX_CAPTURES=2` в `.env` (перезапустить сервер) захватить 3 стикера:
- третий остаётся в **Held captures** как `Paused: session limit`, pill `Session limit`;
- после **Start new session** в dashboard он доставляется сам (до минуты или по открытию popup).

Затем вернуть значение 25.

## Отчёт

Заполните таблицу и пришлите в чат:

| Пункт | Результат (ok / нет / пропущен) | Заметки |
| --- | --- | --- |
| Chrome, версия | | |
| 1.1–1.5 | | |
| 2.1–2.3 | | |
| 3.1–3.6 | | |
| 4.1–4.3 | | |
| 5.1–5.2 | | |
| 6 | | |
