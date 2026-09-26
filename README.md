# Sticker Powerhouse Suite

Локальное offline-first приложение для импорта, каталогизации и преобразования стикеров в форматы Telegram. Основной режим не подключается к TikTok: пользователь вручную передаёт локальные изображения и видео. Дополнительный live-режим получает только тела ответов, уже загруженных вкладкой TikTok, через явно открытую панель Chrome DevTools.

> Ни один неофициальный live-способ нельзя считать ban-safe. DevTools-режим уменьшает технический след по сравнению с CDP/DOM-автоматизацией, но не устраняет риск блокировки или нарушения правил платформы. Для минимального риска используйте только ручной импорт локальных файлов.

## Что изменилось

- Offline/manual import — режим по умолчанию.
- Старые CDP, remote-debugging, content script, DOM observer и CDN refetch удалены из штатного потока.
- Опциональное MV3-расширение использует `chrome.devtools.network.getContent()` и никогда не повторяет запрос к TikTok/CDN.
- Сервер слушает только `127.0.0.1`; dashboard получает HttpOnly same-origin session перед API/WebSocket подключением.
- Extension ingest требует Bearer token и фактические media bytes; URL-only payload не принимается.
- Дедупликация выполняется по SHA-256 содержимого.
- Вместо удаления библиотеки UI создаёт recoverable archive snapshot. Активная библиотека при этом не изменяется.
- При первом запуске legacy JSON недеструктивно мигрирует в schema v2: перед atomic rewrite создаётся stickers_db.backup.json, query подписанных URL удаляются, а missing/stale состояния только помечаются; media-файлы не удаляются.
- Все output-пути приходят от сервера; во frontend нет привязки к диску или каталогу проекта.

## Установка

Требуется Node.js 22.12 или новее и Chrome. FFmpeg поставляется зависимостью проекта.

```powershell
npm run install-all
Copy-Item .env.example .env
```

Для DevTools live-capture подключите расширение в dashboard (**Health → Capture extension**); задавать `INGEST_TOKEN` в `.env` больше не обязательно, но если он задан, он имеет приоритет. Offline/manual import не требует расширения, но dashboard всё равно использует автоматически создаваемую локальную session cookie.

### Разработка

```powershell
npm run dev
```

- Dashboard: `http://127.0.0.1:3000`
- Backend: `http://127.0.0.1:3001`
- Vite проксирует `/api`, `/ws` и media paths к loopback backend, поэтому frontend использует только same-origin URLs.

### Production

```powershell
npm run build
npm start
```

Открывайте адрес, который выводит backend при старте. Не меняйте loopback binding на `0.0.0.0` и не публикуйте сервер в LAN/Internet.

## Основной поток: ручной импорт

1. Запустите приложение; кнопка состояния в шапке показывает **Local · Manual**.
2. Нажмите **Import** или перетащите `png`, `jpg`, `webp`, `gif`, `tif`, `avif`, `mp4`, `webm`, `mov`, `mkv` или `m4v` в любое место окна (до 30 файлов за раз). Панель импорта показывает результат по каждому файлу; с включённым auto-convert новые файлы конвертируются одной задачей.
3. В библиотеке фильтруйте **Ready** / **Needs action**, тип и поиск (ID, исходное имя, теги); фон превью можно переключить на шахматку или приблизительный фон чата Telegram. Вид, фильтры и выбранный стикер сохраняются в адресной строке.
4. Откройте стикер: блок **Telegram check** показывает формат, фактический размер файла к лимиту, длительность, размеры и растягивание исходника. Отсюда — Convert / Retry / Re-convert, **Edit**, теги и **Download**.
5. **Select** включает выбор нескольких стикеров для пакетной конвертации, тегов и добавления в пак; прогресс и отмена очереди — в панели **Jobs** (история в памяти сервера, последние 20 задач).
6. Соберите пак (**Packs**) и экспортируйте ZIP для официального `@Stickers`; публикация остаётся ручной, проект не использует Telegram API.

Ручной импорт не обращается к TikTok и не расходует DevTools capture budget.

## Паки и экспорт для @Stickers

Пак — упорядоченный набор стикеров с названием и эмодзи для каждого стикера. Паки хранятся в `output/packs.json` отдельно от базы стикеров (атомарная запись, предыдущая версия — `packs.backup.json`). Перед самой первой записью паков сервер создаёт archive snapshot библиотеки. Удаление пака удаляет только его порядок и эмодзи — стикеры и файлы остаются.

- **Текущий пак** показан панелью внизу библиотеки: название, число стикеров, первые миниатюры, что мешает экспорту, `Open pack` и `Export for @Stickers`.
- **В инспекторе** выбор эмодзи добавляет стикер в текущий пак; там же меняются эмодзи и убирается стикер. На плитке виден эмодзи из текущего пака (`?` — эмодзи ещё не выбран). Фильтр **Not in a pack** показывает стикеры, которых нет ни в одном паке.
- **Select → Add to pack** добавляет выбранное в порядке страницы; стикеры другого формата и сверх лимита пропускаются с объяснением.
- **Packs**: список паков, порядок (перетаскивание или кнопки ↑/↓ с клавиатуры), эмодзи в каждой строке, переименование, выбор текущего пака, удаление с подтверждением.
- **Экспорт** собирает ZIP в памяти: `001_<id>.webp` … в порядке пака и `pack.txt` с командой бота, шагами и таблицей «№ → файл → эмодзи». Экспорт блокируется, пока есть стикер без эмодзи, не Ready, отсутствующий в библиотеке или пак смешивает форматы.

Правила сверены с документацией Telegram 25.09.2026: до 120 стикеров в паке, 1–20 эмодзи на стикер. Официальный `@Stickers` создаёт статичные паки командой `/newpack`, видео — `/newvideo`, поэтому один пак держит только один формат.

## Опциональный live-поток через DevTools

### Настройка расширения

1. Откройте `chrome://extensions`, включите Developer mode и выберите **Load unpacked** → `extension/`.
2. В dashboard откройте **Health → Capture extension** и нажмите **Connect extension**. Сервер создаёт токен и хранит его в `output/.ingest-token` (вне Git и вне архивов); показать его снова можно кнопкой **Show token**, отозвать — **Disconnect**. Вставьте токен в popup расширения (**Connection token**) и нажмите **Save and reconnect**. Альтернатива — `INGEST_TOKEN` в `.env` (раздел **Advanced** в popup); он имеет приоритет над подключением из dashboard.
3. Оставьте server URL равным `http://127.0.0.1:3001` или `http://localhost:3001`. Расширение доставляет только на порт 3001; при другом `PORT` сервер предупреждает об этом при старте.
4. Включите **Capture enabled**. Popup показывает состояние слушателя (`Capture off`, `DevTools not open`, `DevTools on another site`, `Watching TikTok tab`), локального сервера (`Online`, `Token rejected`, `Capture disabled on server`, `Offline`…) и очереди.

### Захват

1. Откройте TikTok Messages обычным способом.
2. До появления нужного стикера откройте Chrome DevTools на этой вкладке и не закрывайте его. Выбирать панель **Sticker Capture** не обязательно: слушатель работает, пока открыт DevTools; на других сайтах тела ответов не читаются.
3. Расширение проверяет завершившиеся network responses, читает уже доступное тело через DevTools API и отправляет байты только в loopback backend. Тип файла определяется по байтам, заголовок `Content-Type` — только подсказка.
4. При временной localhost-ошибке payload остаётся в локальной очереди до подтверждённого ACK. Повторных TikTok/CDN-запросов нет.
5. Когда исчерпан capture budget сервера, доставка ставится на паузу: захваты хранятся в очереди и уходят сами после **Reset budget** в dashboard. Не перезагружайте чат ради повторного захвата.
6. Захват, который сервер отклонил (`Held captures` в popup), можно повторить, сохранить файлом для ручного импорта или удалить.
7. Панель **Sticker Capture** показывает ленту этой сессии браузера: миниатюру, состояние (`Added to library`, `Already in library`, `Delivering…`, `Held`, `Rejected`) и ссылку **Open in library**. Лента и миниатюры живут только в памяти (`chrome.storage.session`) и исчезают при закрытии Chrome.
8. Если захват был выключен, когда стикеры загрузились, нажмите в панели **Capture from Network log**: расширение пройдёт по ответам, которые DevTools уже записал с момента открытия, через ту же политику. Ни одного нового запроса к TikTok не создаётся — не перезагружайте чат, чтобы «наполнить» журнал.
9. Стикер, который сервер уже принял, повторно не отправляется: расширение помнит хэши (до 2000, сброс при смене токена или адреса сервера).
10. По умолчанию новые захваты конвертируются для Telegram одной задачей на серию (**Health → Capture extension**, флажок автоконвертации; настройка хранится в `output/capture-settings.json`).
11. В панели есть счётчик «TikTok images refused by the policy» с обезличенными примерами путей: аватары там ожидаемы, но много записей `path not sticker specific` или `host not allowed` при видимых в чате стикерах означают, что TikTok сменил формат ссылок и политику пора обновить.

TikTok отдаёт один стикер в нескольких размерах с общим ключом (`…<ключ>~tplv-…-video2sticker-mid.webp`, `…-full.webp`). Dashboard узнаёт ключ по URL захвата или по имени вручную импортированного файла. Если в библиотеке есть более крупный захват того же стикера, инспектор показывает **Open it**, а экран пака — **Use larger capture** (замена сохраняет позицию и эмодзи). Файлы при этом не удаляются.

Сам backend не видит DevTools, поэтому расширение отправляет на localhost короткий heartbeat (состояние слушателя, счётчики очереди, версия — без URL и данных страницы). Пока heartbeat свежий, dashboard показывает то же состояние, что и popup (например `Extension · Watching TikTok tab`, «Last signal 5 s ago»); без него — `Awaiting DevTools` или последнее подтверждённое принятие. Словарь статусов — [docs/extension/SPEC.md](docs/extension/SPEC.md). Отклонённый политикой файл (например, аватар) dashboard показывает отдельно от ошибки доставки.

Расширение не кликает, не скроллит и не изменяет TikTok UI; в manifest нет content script, `debugger`, `tabs` или `webRequest` permissions. Тем не менее live-capture остаётся неофициальной инструментализацией с остаточным account/policy risk. Подробнее: [Account Safety](docs/ACCOUNT_SAFETY.md).

## HAR и официальный экспорт

Импорт HAR пока не считается поддерживаемой возможностью: сначала нужен небольшой sanitized HAR, подтверждающий, что Chrome действительно включил media response bodies нужных стикеров. Даже sanitized HAR может содержать чувствительные URL, тела ответов и фрагменты переписки — не сохраняйте его в Git и удаляйте после локальной проверки.

TikTok Data Portability/Download Your Data можно исследовать отдельно, но текущая документация Direct Messages не гарантирует media bytes стикеров. Эта возможность не является частью runtime приложения.

## Health, проверка хранилища и archive snapshots

Страница **Health** показывает сводку хранилища. **Run check** (`POST /api/storage/check`) сравнивает базу с диском и перечисляет конкретные записи и файлы: missing original/output, interrupted conversions, unlinked files, temporary entries. Проверка меняет только флаги health — ничего не удаляет, не перемещает и не чинит.

**Create archive snapshot** вызывает `POST /api/library/archive`. Сервер копирует текущие database/media files и manifest с SHA-256 в датированный каталог `output/archives/`. Активная библиотека остаётся на месте. Список архивов и **Verify files** пересчитывают хэши по manifest и сообщают о пропавших, изменённых и лишних файлах, не изменяя архив. Восстановления из архива в UI нет.

Web API не предоставляет физическое удаление всей библиотеки. Перед ручным удалением сначала создайте snapshot и проверьте manifest.

## Проверки

```powershell
npm run check
```

Команда запускает backend/unit/integration tests, frontend lint и production build. Для точечной проверки доступны:

```powershell
npm test
npm run lint
npm run build
npm run test:e2e
```

`npm run test:e2e` собирает dashboard и прогоняет UI-сценарии в headless Chrome (установленный Google Chrome, через `playwright-core`) на пустой временной библиотеке: импорт, поиск, клавиатурное скачивание, теги, редактор, пакетные задачи, Health, переподключение, паки (эмодзи, пакетное добавление, перестановка с клавиатуры, экспорт и разбор ZIP, перезапуск, удаление), отсутствие горизонтального переполнения 320–1440 px и каталог из 1000 синтетических записей. Тест не открывает TikTok или Telegram и не трогает `output/`.

Live-приёмка выполняется вручную и только после локальных тестов: открыть DevTools до загрузки одного статического и одного анимированного тестового стикера, затем убедиться в Chrome Network, что расширение не создало дополнительных запросов к TikTok/CDN.

## Основные API

Dashboard сначала вызывает `GET /api/session`; сервер устанавливает HttpOnly `SameSite=Strict` cookie. Следующие dashboard API и `/ws` используют эту same-origin session. Extension использует отдельный Bearer token.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/session` | Создать/обновить dashboard session, вернуть status и output paths |
| `GET` | `/api/status` | Проверить loopback server и capture/storage health |
| `POST` | `/api/ingest` | Принять bytes от DevTools extension; Bearer token обязателен |
| `POST` | `/api/import/files` | Локальный ручной импорт media |
| `POST` | `/api/session/reset` | Начать новый DevTools capture budget |
| `POST` | `/api/extension/pair`, `/api/extension/token`, `/api/extension/unpair` | Подключить расширение / показать токен / отключить (dashboard session) |
| `POST` | `/api/extension/heartbeat` | Состояние слушателя от расширения; Bearer token обязателен |
| `POST` | `/api/extension/settings` | `{ autoConvert }` — автоконвертация новых захватов (dashboard session) |
| `POST` | `/api/library/archive` | Создать неизменяемый snapshot библиотеки |
| `GET` | `/api/library/archives` | Список архивов из manifest |
| `POST` | `/api/library/archives/:id/verify` | Read-only проверка SHA-256 архива |
| `POST` | `/api/storage/check` | Проверка хранилища с элементами по категориям (без удаления) |
| `GET` | `/api/stickers` | Записи библиотеки; `outputSizeBytes` измеряется по файлу при каждом чтении |
| `POST` | `/api/convert` | Конвертировать один стикер в формат Telegram |
| `POST` | `/api/edit-convert-static`, `/api/edit-convert-animated` | Сохранить правку из редактора и конвертировать |
| `POST` | `/api/stickers/:id/tags` | Заменить теги одного стикера |
| `GET` | `/api/jobs` | Пакетные задачи текущего процесса сервера |
| `POST` | `/api/jobs/convert`, `/api/jobs/tags` | Пакетная конвертация / теги с отчётом по каждому ID |
| `POST` | `/api/jobs/:id/cancel` | Отменить не начатые элементы задачи |
| `GET` | `/api/packs` | Паки, текущий пак и лимиты |
| `POST` | `/api/packs` | Создать пак (становится текущим) |
| `POST` | `/api/packs/:id` | Изменить название и/или упорядоченные элементы; `revision` защищает от перезаписи из другой вкладки (409) |
| `POST` | `/api/packs/:id/activate`, `/api/packs/:id/delete` | Сделать текущим / удалить запись пака (стикеры и файлы остаются) |
| `GET` | `/api/packs/:id/export` | ZIP для @Stickers или 409 со списком проблем |

WebSocket `/ws` отправляет `init` (записи, статус, задачи, паки), `new_sticker`, `sticker_update`, `status`, `job_update` и `packs_update`.

## Форматы Telegram

- Static: WebP, прозрачность, одна сторона 512 px, вторая не больше 512 px, до 512 KiB.
- Video sticker: VP9 WebM, прозрачность, без аудио, одна сторона 512 px, до 30 FPS, до 3 секунд, до 256 KiB.

Backend обязан проверять фактический итоговый размер; превышение лимита не должно получать статус `converted`.

- Пак: до 120 стикеров, у каждого 1–20 эмодзи; в `@Stickers` статичные и видео-стикеры собираются в разные паки (`/newpack` и `/newvideo`).

## Структура

```text
extension/             DevTools network-body capture, popup и durable localhost queue
frontend/              React/Vite dashboard
lib/                   URL/media policy, storage, jobs, archives, import и safety helpers
output/                captured, statics, animated, archives, database и packs.json
README.md              запуск и архитектура
docs/ACCOUNT_SAFETY.md подробная модель риска
docs/redesign/          план редизайна, спецификация и отчёты этапов
test/                  unit/integration тесты; test/e2e — UI-сценарии в Chrome
server.js              loopback HTTP/WebSocket API и media pipeline
```

Проект работает только локально и не публикует стикеры автоматически ни в TikTok, ни в Telegram.