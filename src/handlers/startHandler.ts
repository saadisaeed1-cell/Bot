import TelegramBot from 'node-telegram-bot-api';
import { DealCategory, User } from '@prisma/client';
import {
  findOrCreateUser,
  createDeal,
  joinDeal,
  getDeal,
  getDealByCode,
  getUserDeals,
  getDealInviteLink,
  getSellerId,
  getBuyerId,
  dealUserIds,
  markItemDelivered,
  confirmDealCompletion,
  openDispute,
  setDealPaymentAddress,
  acceptParticipantTerms,
  cancelDeal,
  DealWithUsers,
} from '../services/dealService';
import { getEscrowAddress, getDepositMemo } from '../services/paymentService';
import { DEAL_CATEGORIES, getCategoryLabel, buildTermsMessage } from '../services/termsService';
import {
  createDealTopic,
  getDealChatLink,
  notifyDisputeInTopic,
  notifyTopicOnCancel,
  sendPendingTopicLink,
} from '../services/forumService';
import { config } from '../config';
import { sendTrackedMessage, MENU_BUTTON, trackUserMessage } from '../utils/messageTracker';
import { clearWithdrawState } from './withdrawalHandler';

const userState = new Map<number, { action: string; payload?: unknown }>();

const ACTIVE_STATUSES = [
  'PENDING_PARTICIPANT',
  'PENDING_TERMS',
  'PENDING_PAYMENT',
  'FUNDS_FROZEN',
  'DELIVERY_PENDING',
  'DISPUTE',
];

const STATUS_LABELS: Record<string, string> = {
  PENDING_PARTICIPANT: '⏳ Ожидает участника',
  PENDING_TERMS: '📜 Ожидает принятия правил',
  PENDING_PAYMENT: '💳 Ожидает оплаты',
  FUNDS_FROZEN: '🔒 Средства заморожены',
  DELIVERY_PENDING: '📦 Ожидает подтверждения',
  COMPLETED: '✅ Завершена',
  DISPUTE: '⚠️ Спор',
  REFUNDED: '↩️ Возврат покупателю',
  RELEASED_TO_SELLER: '✅ Выплачено продавцу',
  CANCELLED: '❌ Отменена',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function clearUserState(userId: number): void {
  userState.delete(userId);
}

export function getUserState(userId: number) {
  return userState.get(userId);
}

export function setUserState(userId: number, state: { action: string; payload?: unknown }): void {
  userState.set(userId, state);
}

async function sendMainMenu(bot: TelegramBot, chatId: number, userId: number, firstName?: string | null): Promise<void> {
  const deals = await getUserDeals(userId);
  const activeCount = deals.filter((d) => ACTIVE_STATUSES.includes(d.status)).length;

  const text =
    `🛡 *Безопасная экосистема сделок*\n\n` +
    `Добро пожаловать${firstName ? `, ${firstName}` : ''}!\n\n` +
    `Мы гарантируем безопасное проведение сделок с цифровыми активами и криптовалютой. ` +
    `Деньги заморожены на счету сервиса до полного выполнения условий обеими сторонами.\n\n` +
    `💼 Комиссия сервиса: *${config.serviceFeePercent}%*\n` +
    `🆘 Поддержка и арбитраж: *24/7*\n\n` +
    `👇 Выберите нужное действие в меню ниже:`;

  await sendTrackedMessage(bot, chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Создать сделку', callback_data: 'create_deal' }],
        [{ text: `📁 Мои сделки (${activeCount})`, callback_data: 'my_deals' }],
        [{ text: '🔍 Найти сделку', callback_data: 'find_deal' }],
        [{ text: '💰 Кошелек / Баланс', callback_data: 'balance' }],
        [{ text: '📖 Правила и FAQ', callback_data: 'faq' }],
        [{ text: '🆘 Поддержка', callback_data: 'support' }],
      ],
    },
  });
}

async function joinDealFlow(
  bot: TelegramBot,
  chatId: number,
  user: User,
  dealId: string
): Promise<void> {
  try {
    const deal = await joinDeal(dealId, user.id);
    const { sellerId } = dealUserIds(deal);
    const seller = sellerId === deal.creatorId ? deal.creator : deal.participant;
    const participantRole = deal.creatorRole === 'SELLER' ? 'BUYER' : 'SELLER';

    const chatLink = deal.forumTopicId
      ? await getDealChatLink(bot, Number(user.telegramId), deal.forumTopicId, deal.code, deal.id)
      : null;

    await sendTrackedMessage(
      bot,
      chatId,
      `✅ *Вы присоединились к сделке* #${deal.code}\n\n` +
        `👤 *Ваша роль:* ${participantRole === 'BUYER' ? 'покупатель' : 'продавец'}\n` +
        `📦 *Категория:* ${getCategoryLabel(deal.category)}\n` +
        `💰 *Сумма:* ${deal.amount} ${deal.currency}\n` +
        `📝 *Условия:* ${deal.description}\n\n` +
        (chatLink
          ? `💬 *Ваша одноразовая ссылка для входа в группу сделки:*\n${chatLink}\n\nПосле входа бот пришлёт вам прямую ссылку на изолированный топик.\n\n`
          : '') +
        `Прежде чем продолжить, ознакомьтесь с правилами ниже и примите их:\n\n` +
        buildTermsMessage(deal.category, participantRole),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Принимаю условия', callback_data: `terms_accept_participant:${deal.id}` }],
            [MENU_BUTTON],
          ],
        },
      }
    );

    if (seller) {
      await bot.sendMessage(
        seller.telegramId.toString(),
        `🤝 *Участник присоединился к вашей сделке* #${deal.code}\n\n` +
          `Ожидаем, пока он примет правила сделки.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
      );
    }
  } catch (err) {
    await sendTrackedMessage(bot, chatId, `❌ Ошибка присоединения: ${(err as Error).message}`, {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  }
}

async function sendDealsList(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const deals = await getUserDeals(userId);
  if (deals.length === 0) {
    await sendTrackedMessage(bot, chatId, '📁 У вас пока нет сделок.', {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }

  const buttons: TelegramBot.InlineKeyboardButton[][] = deals.map((d) => [
    {
      text: `#${d.code} · ${d.amount} ${d.currency} · ${statusLabel(d.status)}`,
      callback_data: `deal_card:${d.id}`,
    },
  ]);
  buttons.push([MENU_BUTTON]);

  await sendTrackedMessage(bot, chatId, '📁 *Ваши сделки:*\nВыберите сделку для просмотра:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendDealCard(
  bot: TelegramBot,
  chatId: number,
  deal: DealWithUsers,
  user: User
): Promise<void> {
  const { sellerId, buyerId } = dealUserIds(deal);
  const isSeller = sellerId === user.id;
  const isBuyer = buyerId === user.id;
  const isParty = deal.creatorId === user.id || deal.participantId === user.id;
  const partner = deal.creatorId === user.id ? deal.participant : deal.creator;

  const text =
    `📄 *Сделка #${deal.code}*\n\n` +
    `📦 Категория: ${getCategoryLabel(deal.category)}\n` +
    `💰 Сумма: ${deal.amount} ${deal.currency}\n` +
    `📊 Статус: ${statusLabel(deal.status)}\n` +
    `📝 Описание: ${deal.description}\n` +
    `👤 Партнер: ${partner?.firstName ?? 'ожидает присоединения'}`;

  const rows: { text: string; url?: string; callback_data?: string }[][] = [];

  if (deal.forumTopicId && config.forumGroupChatId) {
    const link = await getDealChatLink(bot, Number(user.telegramId), deal.forumTopicId, deal.code, deal.id);
    if (link) rows.push([{ text: '💬 Перейти в чат сделки', url: link }]);
  }

  if (isParty && ['PENDING_PARTICIPANT', 'PENDING_TERMS', 'PENDING_PAYMENT'].includes(deal.status)) {
    rows.push([{ text: '❌ Отменить сделку', callback_data: `deal_cancel:${deal.id}` }]);
  }

  if (isSeller && deal.status === 'FUNDS_FROZEN') {
    rows.push([{ text: '📦 Товар передан', callback_data: `deal:${deal.id}:seller_delivered` }]);
  }

  if (isBuyer && deal.status === 'DELIVERY_PENDING') {
    rows.push([{ text: '✅ Подтвердить / Завершить', callback_data: `deal:${deal.id}:buyer_confirm` }]);
  }

  if (isParty && ['FUNDS_FROZEN', 'DELIVERY_PENDING'].includes(deal.status)) {
    rows.push([{ text: '🚨 Открыть спор', callback_data: `deal:${deal.id}:open_dispute` }]);
  }

  rows.push([MENU_BUTTON]);

  await sendTrackedMessage(bot, chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

export function registerStartHandler(bot: TelegramBot): void {
  bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await findOrCreateUser(msg.from!);

    const arg = match?.[1];
    if (arg?.startsWith('deal_')) {
      const dealId = arg.replace('deal_', '');
      await joinDealFlow(bot, chatId, user, dealId);
      return;
    }

    await sendMainMenu(bot, chatId, user.id, msg.from?.first_name);
  });

  bot.onText(/\/newdeal/, async (msg) => {
    const chatId = msg.chat.id;
    setUserState(msg.from!.id, { action: 'create_deal_role' });
    await sendTrackedMessage(bot, chatId, '👤 Выберите вашу роль в сделке:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 Я продавец', callback_data: 'role_SELLER' }],
          [{ text: '💳 Я покупатель', callback_data: 'role_BUYER' }],
          [MENU_BUTTON],
        ],
      },
    });
  });

  bot.onText(/\/mydeals/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await findOrCreateUser(msg.from!);
    await sendDealsList(bot, chatId, user.id);
  });

  bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await findOrCreateUser(msg.from!);
    await sendTrackedMessage(
      bot,
      chatId,
      `💰 *Ваш баланс:*\n` +
        `USDT: ${user.balanceUsdt.toFixed(2)}\n` +
        `TON: ${user.balanceTon.toFixed(4)}\n\n` +
        `Для вывода напишите /withdraw`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '💸 Вывести', callback_data: 'withdraw' }], [MENU_BUTTON]],
        },
      }
    );
  });
}

export function registerCallbackHandler(bot: TelegramBot): void {
  bot.on('callback_query', async (query) => {
    const chatId = query.message!.chat.id;
    const userId = query.from.id;
    const data = query.data!;
    const user = await findOrCreateUser(query.from);

    await bot.answerCallbackQuery(query.id);

    if (data === 'create_deal') {
      setUserState(userId, { action: 'create_deal_role' });
      await sendTrackedMessage(bot, chatId, '👤 Выберите вашу роль в сделке:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 Я продавец', callback_data: 'role_SELLER' }],
            [{ text: '💳 Я покупатель', callback_data: 'role_BUYER' }],
            [MENU_BUTTON],
          ],
        },
      });
      return;
    }

    if (data === 'my_deals') {
      await sendDealsList(bot, chatId, user.id);
      return;
    }

    if (data === 'find_deal') {
      setUserState(userId, { action: 'find_deal_code' });
      await sendTrackedMessage(bot, chatId, '🔍 Введите 6-значный код сделки:', {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }

    if (data.startsWith('deal_card:')) {
      const dealId = data.replace('deal_card:', '');
      const deal = await getDeal(dealId);
      if (!deal) {
        await sendTrackedMessage(bot, chatId, '❌ Сделка не найдена.', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      await sendDealCard(bot, chatId, deal, user);
      return;
    }

    if (data.startsWith('deal_cancel:')) {
      const dealId = data.replace('deal_cancel:', '');
      try {
        const updated = await cancelDeal(dealId, user.id);
        const partner = updated.creatorId === user.id ? updated.participant : updated.creator;

        await sendTrackedMessage(bot, chatId, `❌ Сделка #${updated.code} отменена.`, {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });

        if (partner) {
          await bot.sendMessage(
            partner.telegramId.toString(),
            `❌ Сделка #${updated.code} была отменена собеседником.`,
            { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
          );
        }

        if (updated.forumTopicId) {
          await notifyTopicOnCancel(bot, updated.forumTopicId, updated.code);
        }
      } catch (err) {
        await sendTrackedMessage(bot, chatId, `❌ Ошибка: ${(err as Error).message}`, {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
      }
      return;
    }

    if (data === 'balance') {
      await sendTrackedMessage(
        bot,
        chatId,
        `💰 *Ваш баланс:*\nUSDT: ${user.balanceUsdt.toFixed(2)}\nTON: ${user.balanceTon.toFixed(4)}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💸 Вывести', callback_data: 'withdraw' }],
              [{ text: '⬅️ В меню', callback_data: 'main_menu' }],
            ],
          },
        }
      );
      return;
    }

    if (data === 'faq') {
      await sendTrackedMessage(
        bot,
        chatId,
        `📖 *Правила и FAQ*\n\n` +
          `1️⃣ *Как работает гарант?*\n` +
          `При создании сделки выбирается тип (Подарки/NFT, Звезды, Аккаунты, Цифровые товары), после чего обе стороны обязаны принять правила, соответствующие категории. Покупатель переводит средства на счёт сервиса. Деньги хранятся в заморозке, пока продавец не передаст товар/услугу, а покупатель не подтвердит получение.\n\n` +
          `2️⃣ *Комиссия*\n` +
          `Сервис берёт ${config.serviceFeePercent}% от суммы сделки при её успешном завершении.\n\n` +
          `3️⃣ *Что если возник спор?*\n` +
          `Любая сторона может открыть спор. Решение администратора (гаранта) является окончательным.\n\n` +
          `4️⃣ *Как вывести средства?*\n` +
          `Используйте команду /withdraw или кнопку «Кошелек / Баланс» → «Вывести».\n\n` +
          `5️⃣ *Поддерживаемые валюты*\n` +
          `USDT и TON.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'main_menu' }]],
          },
        }
      );
      return;
    }

    if (data === 'support') {
      await sendTrackedMessage(
        bot,
        chatId,
        `🆘 *Поддержка и арбитраж*\n\n` +
          `Если у вас возник вопрос или спор по сделке — сначала попробуйте открыть спор прямо внутри сделки (кнопка «Открыть спор»).\n\n` +
          `По остальным вопросам напишите администратору: ${config.adminTelegramId ? `\`${config.adminTelegramId}\`` : 'см. описание бота'}.\n\n` +
          `Мы отвечаем в режиме 24/7.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'main_menu' }]],
          },
        }
      );
      return;
    }

    if (data === 'main_menu') {
      clearUserState(userId);
      clearWithdrawState(userId);
      await sendMainMenu(bot, chatId, user.id, query.from.first_name);
      return;
    }

    if (data.startsWith('role_')) {
      const role = data.replace('role_', '') as 'SELLER' | 'BUYER';
      setUserState(userId, { action: 'create_deal_category', payload: { role } });
      await sendTrackedMessage(bot, chatId, '📦 Выберите тип сделки:', {
        reply_markup: {
          inline_keyboard: [
            ...DEAL_CATEGORIES.map((c) => [{ text: `${c.emoji} ${c.label}`, callback_data: `category_${c.value}` }]),
            [MENU_BUTTON],
          ],
        },
      });
      return;
    }

    if (data.startsWith('category_')) {
      const category = data.replace('category_', '') as DealCategory;
      const state = getUserState(userId);
      const { role } = (state?.payload as { role: 'SELLER' | 'BUYER' }) ?? {};
      if (!role) {
        await sendTrackedMessage(bot, chatId, '❌ Сессия устарела, начните заново: /newdeal', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      setUserState(userId, { action: 'create_deal_terms', payload: { role, category } });
      await sendTrackedMessage(bot, chatId, buildTermsMessage(category, role), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Принимаю условия', callback_data: 'terms_accept_creator' }],
            [MENU_BUTTON],
          ],
        },
      });
      return;
    }

    if (data === 'terms_accept_creator') {
      const state = getUserState(userId);
      const payload = state?.payload as { role: 'SELLER' | 'BUYER'; category: DealCategory } | undefined;
      if (state?.action !== 'create_deal_terms' || !payload) {
        await sendTrackedMessage(bot, chatId, '❌ Сессия устарела, начните заново: /newdeal', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      setUserState(userId, { action: 'create_deal_currency', payload });
      await sendTrackedMessage(bot, chatId, '💱 Выберите валюту сделки:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💵 USDT', callback_data: 'currency_USDT' }],
            [{ text: '💎 TON', callback_data: 'currency_TON' }],
            [MENU_BUTTON],
          ],
        },
      });
      return;
    }

    if (data.startsWith('terms_accept_participant:')) {
      const dealId = data.replace('terms_accept_participant:', '');
      try {
        const updated = await acceptParticipantTerms(dealId, user.id);
        const seller = getSellerId(updated) === updated.creatorId ? updated.creator : updated.participant;
        const buyer = getBuyerId(updated) === updated.creatorId ? updated.creator : updated.participant;

        const escrowAddress = await getEscrowAddress();
        const memo = getDepositMemo(updated.code);
        const withAddress = await setDealPaymentAddress(updated.id, escrowAddress ?? 'NOT_CONFIGURED');

        const paymentInstruction =
          escrowAddress
            ? `💳 Переведите *точную* сумму *${withAddress.amount} ${withAddress.currency}* на адрес бота:\n` +
              `\`${escrowAddress}\`\n\n` +
              `⚠️ *Обязательно укажите в комментарии/сообщении к переводу код:* \`${memo}\`\n\n` +
              `Без правильного кода платёж не будет засчитан автоматически.`
            : `⚠️ Платёжный адрес не настроен. Обратитесь в поддержку.`;

        await sendTrackedMessage(
          bot,
          chatId,
          `✅ Условия приняты!\n\n${paymentInstruction}\n\n` +
            `После поступления средств сделка перейдёт в статус «Средства заморожены».`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
        );

        if (seller) {
          await bot.sendMessage(
            seller.telegramId.toString(),
            `✅ Участник принял правила сделки #${updated.code}. Ожидаем поступления средств от покупателя.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
          );
        }
      } catch (err) {
        await sendTrackedMessage(bot, chatId, `❌ Ошибка: ${(err as Error).message}`, {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
      }
      return;
    }

    if (data.startsWith('currency_')) {
      const currency = data.replace('currency_', '') as 'USDT' | 'TON';
      const state = getUserState(userId);
      setUserState(userId, {
        action: 'create_deal_amount',
        payload: { ...(state?.payload as object), currency },
      });
      await sendTrackedMessage(bot, chatId, `💱 Сделка в ${currency}. Введите сумму (например, 100):`, {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }

    if (data.startsWith('deal:')) {
      const [, dealId, action] = data.split(':');
      const deal = await getDeal(dealId);
      if (!deal) {
        await sendTrackedMessage(bot, chatId, '❌ Сделка не найдена.', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }

      if (action === 'seller_delivered' && getSellerId(deal) === user.id) {
        const updated = await markItemDelivered(deal.id, user.id);
        const buyer = getBuyerId(updated) === updated.creatorId ? updated.creator : updated.participant;
        await sendTrackedMessage(
          bot,
          chatId,
          `📦 Вы отметили товар как переданный по сделке #${updated.code}. Ожидайте подтверждения покупателя.`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
        );
        if (buyer) {
          await bot.sendMessage(
            buyer.telegramId.toString(),
            `📦 Продавец отметил сделку #${updated.code} как выполненную. Проверьте товар и нажмите «Подтвердить получение».`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '✅ Подтвердить получение', callback_data: `deal:${updated.id}:buyer_confirm` }],
                  [{ text: '⚠️ Открыть спор', callback_data: `deal:${updated.id}:open_dispute` }],
                  [MENU_BUTTON],
                ],
              },
            }
          );
        }
      }

      if (action === 'buyer_confirm' && getBuyerId(deal) === user.id) {
        const updated = await confirmDealCompletion(deal.id, user.id);
        const seller = getSellerId(updated) === updated.creatorId ? updated.creator : updated.participant;
        await sendTrackedMessage(
          bot,
          chatId,
          `✅ Сделка #${updated.code} завершена. Спасибо!`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
        );
        if (seller) {
          await bot.sendMessage(
            seller.telegramId.toString(),
            `✅ Сделка #${updated.code} подтверждена покупателем. Средства зачислены на ваш баланс.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
          );
        }
      }

      if (
        action === 'open_dispute' &&
        (getBuyerId(deal) === user.id || getSellerId(deal) === user.id)
      ) {
        setUserState(userId, { action: 'dispute_reason', payload: { dealId: deal.id } });
        await sendTrackedMessage(bot, chatId, '⚠️ Опишите причину спора:', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
      }

      return;
    }
  });
}

export function registerMessageHandler(bot: TelegramBot): void {
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const userId = msg.from!.id;
    const chatId = msg.chat.id;

    // Track the user's message so it can be cleaned up once we reply.
    trackUserMessage(chatId, msg.message_id);

    const state = getUserState(userId);
    if (!state) return;

    const user = await findOrCreateUser(msg.from!);

    if (state.action === 'find_deal_code') {
      const code = msg.text.trim();
      if (!/^\d{6}$/.test(code)) {
        await sendTrackedMessage(bot, chatId, 'Код должен состоять из 6 цифр. Попробуйте снова:', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      clearUserState(userId);
      const deal = await getDealByCode(code);
      if (!deal) {
        await sendTrackedMessage(bot, chatId, '❌ Сделка с таким кодом не найдена.', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      await joinDealFlow(bot, chatId, user, deal.id);
      return;
    }

    if (state.action === 'create_deal_amount') {
      const amount = parseFloat(msg.text.replace(',', '.'));
      if (Number.isNaN(amount) || amount <= 0) {
        await sendTrackedMessage(bot, chatId, 'Введите корректную положительную сумму.', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      setUserState(userId, {
        action: 'create_deal_description',
        payload: { ...(state.payload as Record<string, unknown>), amount },
      });
      await sendTrackedMessage(bot, chatId, 'Введите описание товара/услуги:', {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }

    if (state.action === 'create_deal_description') {
      const { role, category, currency, amount } = state.payload as {
        role: 'SELLER' | 'BUYER';
        category: DealCategory;
        currency: 'USDT' | 'TON';
        amount: number;
      };
      try {
        const deal = await createDeal({
          creatorId: user.id,
          creatorRole: role,
          category,
          amount,
          description: msg.text,
          currency,
        });

        const topicId = await createDealTopic(bot, deal.id, deal.code);
        const chatLink = topicId ? await getDealChatLink(bot, msg.from!.id, topicId, deal.code, deal.id) : null;

        const link = getDealInviteLink(deal.id);
        const roleText = role === 'SELLER' ? 'продавец' : 'покупатель';

        await sendTrackedMessage(
          bot,
          chatId,
          `✅ *Сделка #${deal.code} создана!*\n\n` +
            `👤 *Ваша роль:* ${roleText}\n` +
            `📦 *Категория:* ${getCategoryLabel(category)}\n` +
            `💱 *Валюта:* ${currency}\n` +
            `💰 *Сумма:* ${amount}\n` +
            `📝 *Описание:* ${msg.text}\n\n` +
            `🔑 *Код сделки для второго участника:* \`${deal.code}\`\n` +
            `Он может ввести его через «🔍 Найти сделку» или перейти по ссылке:\n${link}\n\n` +
            (chatLink
              ? `💬 *Чат сделки создан.*\nВаша одноразовая ссылка для входа в группу:\n${chatLink}\n\nПосле входа бот пришлёт вам прямую ссылку на изолированный топик.\n\n`
              : '') +
            `⏳ После того как участник присоединится и примет правила сделки, вы получите реквизиты для оплаты.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                ...(chatLink ? [[{ text: '💬 Перейти в чат сделки', url: chatLink }]] : []),
                [MENU_BUTTON],
              ],
            },
          }
        );
      } catch (err) {
        await sendTrackedMessage(bot, chatId, `❌ Ошибка: ${(err as Error).message}`, {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
      }
      clearUserState(userId);
      return;
    }

    if (state.action === 'dispute_reason') {
      const { dealId } = state.payload as { dealId: string };
      try {
        const updated = await openDispute(dealId, user.id, msg.text);
        await sendTrackedMessage(
          bot,
          chatId,
          `⚠️ Спор по сделке #${updated.code} открыт. Администратор скоро рассмотрит его.`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
        );

        await bot.sendMessage(
          config.adminTelegramId.toString(),
          `⚠️ *Новый спор!*\nСделка #${updated.code}\nСумма: ${updated.amount} ${updated.currency}\n` +
            `Причина: ${msg.text}\nИспользуйте /disputes`,
          { parse_mode: 'Markdown' }
        );

        if (updated.forumTopicId) {
          await notifyDisputeInTopic(bot, updated.forumTopicId, config.adminTelegramId, updated.code, msg.text);
        }
      } catch (err) {
        await sendTrackedMessage(bot, chatId, `❌ Ошибка: ${(err as Error).message}`, {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
      }
      clearUserState(userId);
      return;
    }
  });

  // Listen for users joining the private forum group, then send them the direct
  // link to their isolated deal topic in PM.
  bot.on('chat_member', async (update) => {
    try {
      const newStatus = update.new_chat_member?.status;
      if (newStatus !== 'member' && newStatus !== 'administrator' && newStatus !== 'creator') {
        return;
      }
      const userId = update.new_chat_member?.user?.id;
      if (!userId) return;
      await sendPendingTopicLink(bot, userId);
    } catch (err) {
      console.error('chat_member handler error:', err);
    }
  });
}

export function registerPaymentNotificationHandler(bot: TelegramBot): void {
  // Deprecated: use services/paymentWatcher.ts instead.
  console.log('Payment watcher: implement cron/webhook for blockchain deposits');
}
