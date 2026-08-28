# Telegram Escrow Bot

Полноценный Telegram-бот гаранта (escrow) для безопасных сделок с криптовалютой.

## Стек

- **Runtime:** Node.js 18+
- **Language:** TypeScript
- **Bot API:** `node-telegram-bot-api`
- **ORM:** Prisma
- **Database:** PostgreSQL (Neon / Render / self-hosted)
- **Crypto:** TRON (USDT TRC20) + TON

## Возможности

- Создание сделки продавцом или покупателем
- Уникальный 6-значный код сделки + ссылка-приглашение для второго участника
- Изолированный чат сделки (Forum Topic) в отдельной супергруппе с закреплённым дисклеймером
- Генерация уникального адреса для оплаты
- Автоматическое замораживание средств в эскроу
- Подтверждение получения товара
- Автоматическая выплата продавцу с удержанием комиссии
- Разрешение споров администратором
- Вывод средств на внешний кошелек
- Логирование всех статусов и транзакций

## Структура проекта

```
.
├── src/
│   ├── bot.ts                    # Точка входа
│   ├── config.ts                 # ENV конфигурация
│   ├── db.ts                     # Prisma client
│   ├── handlers/
│   │   ├── startHandler.ts       # Создание/присоединение к сделке
│   │   ├── adminHandler.ts       # Админ-команды
│   │   └── withdrawalHandler.ts  # Вывод средств
│   └── services/
│       ├── dealService.ts        # Бизнес-логика сделок
│       ├── forumService.ts       # Forum Topics — изолированный чат на сделку
│       ├── termsService.ts       # Тексты правил по категориям сделок
│       ├── paymentService.ts     # Крипто-платежи
│       └── paymentWatcher.ts     # Cron-наблюдатель за депозитами
├── prisma/
│   └── schema.prisma             # Схема Prisma
├── schema.sql                    # Чистая SQL-схема
├── .env.example                  # Пример переменных окружения
├── railway.json                  # Конфигурация Railway
├── Dockerfile                    # Docker-образ
├── vercel.json                   # Конфигурация Vercel
├── package.json
├── tsconfig.json
└── README.md
```

## Быстрый старт

### 1. Клонирование и установка

```bash
git clone <repo>
cd telegram-escrow-bot
npm install
```

### 2. Настройка переменных окружения

```bash
cp .env.example .env
# Отредактируйте .env
```

Обязательные переменные:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_TELEGRAM_ID=123456789
DATABASE_URL=postgresql://...
SERVICE_FEE_PERCENT=3
```

### 3. Миграции базы данных

```bash
npx prisma migrate dev --name init
npx prisma generate
```

Или выполните `schema.sql` вручную через psql/Neon SQL Editor.

### 4. Запуск в режиме разработки

```bash
npm run dev
```

### 5. Сборка и запуск в продакшене

```bash
npm run build
npm start
```

## Деплой

### Railway (рекомендуется)

1. Создай аккаунт на [Railway](https://railway.app).
2. Создай новый проект и выбери **Deploy from GitHub repo**.
3. Подключи свой репозиторий с ботом.
4. Добавь сервис **PostgreSQL** в проект (Railway сам создаст `DATABASE_URL`).
5. Перейди в настройки твоего сервиса бота → **Variables** → добавь:
   - `BOT_TOKEN`
   - `ADMIN_TELEGRAM_ID`
   - `SERVICE_FEE_PERCENT=3`
   - `TRON_API_KEY` (опционально)
   - `TRON_ESCROW_PRIVATE_KEY` (опционально)
   - `TON_API_KEY`, `TON_ESCROW_MNEMONIC` (опционально)
6. В разделе **Settings** установи:
   - **Start Command:** `npx prisma migrate deploy && node dist/bot.js`
   - **Healthcheck Path:** `/health`
   - **Healthcheck Port:** `3000`
7. Нажми **Deploy**.

Бот запустится в polling-режиме. Healthcheck доступен по адресу `https://your-app.up.railway.app/health`.

### Vercel (Serverless)

1. Создайте проект на [Vercel](https://vercel.com).
2. Подключите GitHub репозиторий.
3. Добавьте переменные окружения в Dashboard → Settings → Environment Variables.
4. Установите `WEBHOOK_URL=https://your-app.vercel.app`.
5. Убедитесь, что в `vercel.json` указан `src/bot.ts` как entrypoint или используйте отдельный HTTP-сервер для webhook.

Важно: Vercel бесплатный tier ограничивает время выполнения (10 с), поэтому polling-режим не подходит. Используйте webhook и вынесите cron-наблюдение за депозитами в отдельный сервис (например, GitHub Actions cron, Railway или VPS).

### Railway / Render

1. Создайте PostgreSQL-базу в сервисе.
2. Подключите репозиторий.
3. Укажите `DATABASE_URL` и остальные переменные.
4. Запустите: `npm run db:migrate && npm start`.

### VPS / Dedicated server

```bash
# Установка зависимостей
npm ci
npm run build
npx prisma migrate deploy

# Запуск через systemd / pm2
npm install -g pm2
pm2 start dist/bot.js --name escrow-bot
pm2 save
pm2 startup
```

## Криптовалютные платежи

### USDT TRC20

Для работы с USDT TRC20 необходимы:

- Приватный ключ эскроу-кошелька (`TRON_ESCROW_PRIVATE_KEY`)
- API ключ TronGrid (`TRON_API_KEY`)
- Адрес контракта USDT (`USDT_TRC20_CONTRACT`)

Бот генерирует уникальный TRON-адрес для каждой сделки. После получения оплаты администратор должен периодически "свипать" средства на основной эскроу-кошелек через `sweepUsdtTrc20()`.

### TON

TON-интеграция является заглушкой. Для полноценной работы подключите `@ton/ton` / `@ton/crypto`:

1. Создайте кошелек из мнемоники.
2. Генерируйте sub-адреса для каждой сделки.
3. Проверяйте поступления через TonCenter API или `@ton/ton`.

## Изолированный чат сделки (Forum Topics)

Каждая сделка получает свою тему (Topic) в отдельной супергруппе — там продавец и покупатель
обязаны вести все переговоры и передавать данные, что фиксируется закреплённым дисклеймером.

Настройка:

1. Создайте супергруппу в Telegram и включите **Topics** (Тема форума) в настройках группы.
2. Добавьте бота в группу администратором с правом **Manage Topics**.
3. Узнайте `chat_id` группы (например, добавив временно @RawDataBot или через `getUpdates`).
4. Укажите переменную `FORUM_GROUP_CHAT_ID` (вида `-1001234567890`).
5. Если группа публичная — дополнительно укажите `FORUM_GROUP_USERNAME` (без `@`), чтобы ссылки на темы открывались напрямую.

Если `FORUM_GROUP_CHAT_ID` не задан, бот продолжает работать без изолированных чатов (функция отключается автоматически).

## Администрирование

Команды для администратора (ID из `ADMIN_TELEGRAM_ID`):

- `/disputes` — список открытых споров с кнопками решения
- `/deal <id_или_код>` — информация о сделке (можно указать 6-значный код)
- `/stats` — общая статистика

## Безопасность

- Все изменения балансов и статусов сделок выполняются внутри Serializable-транзакций Prisma.
- Используется `SELECT FOR UPDATE` через raw SQL для атомарного обновления балансов.
- Переходы статусов защищены проверкой текущего статуса в `WHERE`.
- Админ-команды проверяют `ADMIN_TELEGRAM_ID`.

## Лицензия

MIT
