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

Для DevTools live-capture задайте в `.env` длинный случайный `INGEST_TOKEN`. Offline/manual import не требует расширения, но dashboard всё равно использует автоматически создаваемую локальную session cookie.

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
5. **Select** включает выбор нескольких стикеров для пакетной конвертации и тегов; прогресс и отмена очереди — в панели **Jobs** (история в памяти сервера, последние 20 задач).
6. Загружайте файлы в Telegram вручную через официальный `@Stickers`; проект не использует Telegram API.

Ручной импорт не обращается к TikTok и не расходует DevTools capture budget.

## Опциональный live-поток через DevTools

### Настройка расширения

1. Откройте `chrome://extensions`, включите Developer mode и выберите **Load unpacked** → `extension/`.
2. Откройте popup расширения. При первой установке token генерируется локально; скопируйте его в `INGEST_TOKEN` файла `.env` и перезапустите backend.
3. Оставьте server URL равным `http://127.0.0.1:3001` или `http://localhost:3001`.
4. Popup отдельно показывает состояние DevTools listener, localhost server и durable retry queue.

### Захват

1. Откройте TikTok Messages обычным способом.
2. До появления нужного стикера откройте Chrome DevTools.
3. Выберите панель **Sticker Capture** и оставьте её открытой.
4. Расширение проверяет завершившиеся network responses, читает уже доступное тело через DevTools API и отправляет байты только в loopback backend.
5. При временной localhost-ошибке payload остаётся в локальной очереди до подтверждённого ACK. Повторных TikTok/CDN-запросов нет.

Backend не может достоверно определить, открыта ли панель DevTools прямо сейчас. Поэтому dashboard показывает `awaiting`, последнее подтверждённое принятие или ошибку локальной доставки, а фактический listener state смотрите в popup расширения.

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

`npm run test:e2e` собирает dashboard и прогоняет UI-смоук в headless Chrome (установленный Google Chrome, через `playwright-core`) на пустой временной библиотеке: импорт, поиск, клавиатурное скачивание, теги, редактор, пакетные задачи, Health, переподключение, отсутствие горизонтального переполнения 320–1440 px и каталог из 1000 синтетических записей. Тест не открывает TikTok или Telegram и не трогает `output/`.

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

WebSocket `/ws` отправляет `init` (записи, статус, задачи), `new_sticker`, `sticker_update`, `status` и `job_update`.

## Форматы Telegram

- Static: WebP, прозрачность, одна сторона 512 px, вторая не больше 512 px, до 512 KiB.
- Video sticker: VP9 WebM, прозрачность, без аудио, одна сторона 512 px, до 30 FPS, до 3 секунд, до 256 KiB.

Backend обязан проверять фактический итоговый размер; превышение лимита не должно получать статус `converted`.

## Структура

```text
extension/             DevTools network-body capture, popup и durable localhost queue
frontend/              React/Vite dashboard
lib/                   URL/media policy, storage, jobs, archives, import и safety helpers
output/                captured, statics, animated, archives и database
README.md              запуск и архитектура
docs/ACCOUNT_SAFETY.md подробная модель риска
docs/redesign/          план редизайна, спецификация и отчёты этапов
test/                  unit/integration тесты; test/e2e — UI-смоук в Chrome
server.js              loopback HTTP/WebSocket API и media pipeline
```

Проект работает только локально и не публикует стикеры автоматически ни в TikTok, ни в Telegram.