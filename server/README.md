# Облачная функция озвучки своих фраз

Код — `index.js`. Работает в Yandex Cloud Functions, озвучивает свои фразы пользователей
голосом SpeechKit и хранит готовые mp3 в закрытом хранилище `affirmacii-voice`.
Приложение получает звук прямо от функции, поэтому хранилище остаётся закрытым.

## Как загрузить (один раз)

### А. Сервисный аккаунт — «сотрудник», от имени которого работает функция
Консоль → **Все сервисы** → **Identity and Access Management** → **Сервисные аккаунты** → **Создать**:
- имя: `affirmacii-function`
- роли (кнопка «Добавить роль»): `ai.speechkit-tts.user` и `storage.editor`

### Б. Функция
Консоль → **Все сервисы** → **Cloud Functions** → **Создать функцию**, имя `affirmacii-tts`.

1. На странице функции включите **«Публичная функция»** — чтобы приложение могло к ней обращаться
   (защита — проверка подписи Telegram внутри кода).
2. **Редактор** → «Создать версию»:
   - Среда выполнения: **Node.js 22** (или самая новая Node.js);
   - Способ: **Редактор кода** → создать файл `index.js` и вставить в него всё содержимое `server/index.js`;
   - Точка входа: `index.handler`;
   - Таймаут: `15` секунд, память: `128 МБ`;
   - Сервисный аккаунт: `affirmacii-function`;
   - Переменные окружения:

     | Ключ | Значение |
     |---|---|
     | `BOT_TOKEN` | токен бота от BotFather (секрет — никому не показывать) |
     | `BUCKET` | `affirmacii-voice` |
     | `FOLDER_ID` | `b1gqlqg5ju01p6oeh7tr` |
     | `LIMIT_PER_USER_DAY` | `40` |
     | `LIMIT_TOTAL_MONTH` | `1800` |
     | `ALLOWED_ORIGINS` | `https://gaer-333.github.io,http://localhost:8080` |
   - **Сохранить изменения**.
3. На вкладке **«Обзор»** скопировать **ссылку для вызова** (`https://functions.yandexcloud.net/…`) —
   она не секретная, её знает приложение.

## Как поменять лимиты или голоса
Функция → **Редактор** → поменять переменную окружения → **Сохранить изменения**. Код и приложение не трогаем.
Голоса — переменная `VOICES` (JSON в том же формате, что `VOICES_DEFAULT` в коде).

## Ответы функции
- `200 {audio, cached, left}` — mp3 в base64; `cached: true` — фраза уже была озвучена (бесплатно)
- `401 not_telegram` — нет или неверная подпись Telegram
- `400 empty | too_long | bad_voice`
- `429 limit_user` — дневной лимит человека; `429 limit_total` — месячный предел на всех
- `502 tts_failed` — SpeechKit или хранилище не ответили

---

# Бот: приветствие и аффирмация дня (`bot.js`)

Отдельная функция `affirmacii-bot`. Отвечает на `/start` и `/stop`, а раз в день (таймер) рассылает
подписчикам одну аффирмацию текстом с кнопкой «Слушать». Подписчики — в том же хранилище, `bot/subscribers/`.

### А. Функция
Cloud Functions → **Создать функцию** `affirmacii-bot` → включить **«Публичная функция»** →
**Редактор**: Node.js 22, файл `index.js` = содержимое `server/bot.js`, точка входа `index.handler`,
таймаут `60` секунд, память `128 МБ`, сервисный аккаунт `affirmacii-function`. Переменные окружения:

| Ключ | Значение |
|---|---|
| `BOT_TOKEN` | токен бота (секрет) |
| `WEBHOOK_SECRET` | любое придуманное слово из латинских букв и цифр, 20+ символов (секрет) |
| `BUCKET` | `affirmacii-voice` |
| `APP_URL` | `https://gaer-333.github.io/affirmacii-bot/` |

### Б. Вебхук — сказать Telegram, куда присылать сообщения
Открыть в браузере (подставив свои значения, без пробелов и угловых скобок):
```
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=<ССЫЛКА_ФУНКЦИИ>&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message","my_chat_member"]
```
Ответ должен быть `{"ok":true,"result":true,"description":"Webhook was set"}`.

### В. Таймер — рассылка каждый день в 9:00 по Москве
1. Сервисному аккаунту `affirmacii-function` добавить роль `functions.functionInvoker`.
2. Cloud Functions → **Триггеры** → **Создать триггер**: имя `affirmacii-daily`, тип **Таймер**,
   cron-выражение `0 6 ? * * *` (6:00 по UTC = 9:00 по Москве), функция `affirmacii-bot`, тег `$latest`,
   сервисный аккаунт `affirmacii-function`.

### Г. Пока Яндекс не пускает запросы из-за границы — «забирать сообщения самим»
Telegram шлёт вебхук из-за границы, и сейчас он до функции не доходит. Временная схема:
1. Обновить код функции `affirmacii-bot` (новый `server/bot.js`) → «Сохранить изменения».
2. Отключить вебхук — открыть в браузере: `https://api.telegram.org/bot<ТОКЕН>/deleteWebhook`
   (ответ `{"ok":true,...}`). Пока вебхук включён, забирать сообщения нельзя.
3. Триггер: Cloud Functions → Триггеры → Создать: имя `affirmacii-poll`, тип **Таймер**,
   cron `* * ? * * *` (каждую минуту), **Данные: `poll`**, функция `affirmacii-bot`, тег `$latest`,
   сервисный аккаунт `affirmacii-function`.

Когда доступ из-за границы вернётся: удалить триггер `affirmacii-poll` и снова включить вебхук (шаг Б) —
бот снова будет отвечать мгновенно.

---

# Бот на Cloudflare Workers (`worker.js`) — основной вариант

Из Яндекс Облака сейчас нет связи с Telegram (ни входящей, ни исходящей — проверено 07.11.2026),
поэтому бот живёт на Cloudflare Workers: бесплатно, серверы за границей, Telegram доступен в обе стороны.
Логика та же, что в `bot.js`; подписчики — в хранилище Cloudflare KV.

1. **Воркер:** dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker** (Hello World) →
   имя `affirmacii-bot` → **Deploy**. Потом **Edit code** → заменить весь код на `server/worker.js` → **Deploy**.
2. **Хранилище:** **Storage & Databases → KV** → **Create** → имя `affirmacii-subs`.
3. **Подключить хранилище к воркеру:** воркер → **Settings → Bindings → Add → KV namespace**:
   Variable name `SUBS`, namespace `affirmacii-subs` → сохранить.
4. **Секреты:** воркер → **Settings → Variables and Secrets → Add**, тип **Secret**:
   `BOT_TOKEN` = токен бота, `WEBHOOK_SECRET` = секретное слово → сохранить (Deploy).
5. **Таймер:** воркер → **Settings → Trigger events (Triggers) → Cron Triggers → Add**:
   `*/5 6 * * *` — каждые 5 минут с 6:00 до 6:55 по UTC (9:00–9:55 по Москве), порциями по 45 человек.
6. **Адрес воркера** (вида `https://affirmacii-bot.<ваше-имя>.workers.dev`) — открыть в браузере:
   должно быть «Бот аффирмаций работает 🌙».
7. **Подключить бота:** открыть в браузере
   `https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=<АДРЕС_ВОРКЕРА>&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message","my_chat_member"]`.
8. В Яндексе удалить триггеры `affirmacii-poll` и `affirmacii-daily` (функция `affirmacii-bot` больше не нужна).

Ограничения бесплатного тарифа: 100 000 сообщений боту в день, рассылка — до ~540 подписчиков
(12 запусков × 45). Больше — платный тариф Workers ($5/мес) или увеличить окно рассылки.
