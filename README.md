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

1. Запустите приложение и дождитесь статуса **Offline mode · manual import**.
2. Перетащите `png`, `jpg`, `webp`, `gif`, `tif`, `avif`, `mp4`, `webm`, `mov`, `mkv` или `m4v` в область импорта.
3. При необходимости выберите временной диапазон анимации, добавьте теги или откройте Canvas Editor.
4. Конвертируйте и скачайте результат либо откройте server-reported output path.
5. Загружайте файлы в Telegram вручную через официальный `@Stickers`; проект не использует Telegram API.

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

## Библиотека и archive snapshots

Кнопка **Create archive snapshot** вызывает `POST /api/library/archive`. Сервер копирует текущие database/media files и manifest с SHA-256 в датированный каталог `output/archives/`. Активная библиотека остаётся на месте и продолжает работать.

Web API не предоставляет физическое удаление всей библиотеки. Перед ручным удалением сначала создайте snapshot и проверьте manifest.

## Проверки

```powershell
npm run check
```

Команда запускает backend/unit tests, frontend lint и production build. Для точечной проверки доступны:

```powershell
npm test
npm run lint
npm run build
```

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
| `GET` | `/api/stickers` | Получить записи библиотеки |
| `POST` | `/api/convert` | Конвертировать стикер в формат Telegram |

## Форматы Telegram

- Static: WebP, прозрачность, одна сторона 512 px, вторая не больше 512 px, до 512 KiB.
- Video sticker: VP9 WebM, прозрачность, без аудио, одна сторона 512 px, до 30 FPS, до 3 секунд, до 256 KiB.

Backend обязан проверять фактический итоговый размер; превышение лимита не должно получать статус `converted`.

## Структура

```text
extension/             DevTools network-body capture, popup и durable localhost queue
frontend/              React/Vite dashboard
lib/                   URL/media policy, storage, import и safety helpers
output/                captured, statics, animated, archives и database
README.md              запуск и архитектура
docs/ACCOUNT_SAFETY.md подробная модель риска
server.js              loopback HTTP/WebSocket API и media pipeline
```

Проект работает только локально и не публикует стикеры автоматически ни в TikTok, ни в Telegram.