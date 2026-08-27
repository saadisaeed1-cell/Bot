import TelegramBot from 'node-telegram-bot-api';
import {
  findOrCreateUser,
  createDeal,
  joinDeal,
  getDeal,
  getUserDeals,
  getDealInviteLink,
  getSellerId,
  getBuyerId,
  dealUserIds,
  markItemDelivered,
  confirmDealCompletion,
  openDispute,
  setDealPaymentAddress,
} from '../services/dealService';
import { generateUsdtTrc20Address, generateTonAddress } from '../services/paymentService';
import { config } from '../config';

const userState = new Map<number, { action: string; payload?: unknown }>();

export function clearUserState(userId: number): void {
  userState.delete(userId);
}

export function getUserState(userId: number) {
  return userState.get(userId);
}

export function setUserState(userId: number, state: { action: string; payload?: unknown }): void {
  userState.set(userId, state);
}

export function registerStartHandler(bot: TelegramBot): void {
  bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await findOrCreateUser(msg.from!);

    const arg = match?.[1];
    if (arg?.startsWith('deal_')) {
      const dealId = arg.replace('deal_', '');
      try {
        const deal = await joinDeal(dealId, user.id);
        const { sellerId, buyerId } = dealUserIds(deal);
        const seller = sellerId === deal.creatorId ? deal.creator : deal.participant;
        const buyer = buyerId === deal.creatorId ? deal.creator : deal.participant;

        await bot.sendMessage(
          chatId,
          `Вы присоединились к сделке *#${deal.id}*.\n\n` +
            `*Роль:* ${deal.creatorRole === 'SELLER' ? 'покупатель' : 'продавец'}\n` +
            `*Сумма:* ${deal.amount} ${deal.currency}\n` +
            `*Условия:* ${deal.description}\n\n` +
            `${buyer?.telegramId === user.telegramId ? 'Ожидайте реквизиты для оплаты от бота.' : 'Ожидайте оплаты от покупателя.'}`,
          { parse_mode: 'Markdown' }
        );

        if (seller) {
          await bot.sendMessage(
            seller.telegramId.toString(),
            `Участник присоединился к вашей сделке *#${deal.id}*.\n\n` +
              `Если вы продавец — отправьте товар/услугу после поступления средств в эскроу.`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (err) {
        await bot.sendMessage(chatId, `Ошибка присоединения: ${(err as Error).message}`);
      }
      return;
    }

    await bot.sendMessage(
      chatId,
      `Добро пожаловать в Escrow-бот!\n\n` +
        `Здесь вы можете безопасно проводить сделки с криптовалютой.\n\n` +
        `Выберите действие:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Создать сделку', callback_data: 'create_deal' }],
            [{ text: 'Мои сделки', callback_data: 'my_deals' }],
            [{ text: 'Баланс', callback_data: 'balance' }],
          ],
        },
      }
    );
  });

  bot.onText(/\/newdeal/, async (msg) => {
    const chatId = msg.chat.id;
    setUserState(msg.from!.id, { action: 'create_deal_role' });
    await bot.sendMessage(chatId, 'Выберите вашу роль в сделке:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Я продавец', callback_data: 'role_SELLER' }],
          [{ text: 'Я покупатель', callback_data: 'role_BUYER' }],
        ],
      },
    });
  });

  bot.onText(/\/mydeals/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await findOrCreateUser(msg.from!);
    const deals = await getUserDeals(user.id);
    if (deals.length === 0) {
      await bot.sendMessage(chatId, 'У вас пока нет сделок.');
      return;
    }

    const lines = deals.map((d) => {
      const partner = d.creatorId === user.id
        ? (d.participant?.firstName ?? 'ожидает')
        : d.creator.firstName;
      return `#${d.id.slice(0, 8)} — ${d.amount} ${d.currency} — ${d.status} (с ${partner})`;
    });

    await bot.sendMessage(chatId, `Ваши сделки:\n\n${lines.join('\n')}`);
  });

  bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await findOrCreateUser(msg.from!);
    await bot.sendMessage(
      chatId,
      `Ваш баланс:\n` +
        `USDT: ${user.balanceUsdt.toFixed(2)}\n` +
        `TON: ${user.balanceTon.toFixed(4)}\n\n` +
        `Для вывода напишите /withdraw`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Вывести', callback_data: 'withdraw' }]],
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
      await bot.sendMessage(chatId, 'Выберите вашу роль в сделке:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Я продавец', callback_data: 'role_SELLER' }],
            [{ text: 'Я покупатель', callback_data: 'role_BUYER' }],
          ],
        },
      });
      return;
    }

    if (data === 'my_deals') {
      const deals = await getUserDeals(user.id);
      if (deals.length === 0) {
        await bot.sendMessage(chatId, 'У вас пока нет сделок.');
        return;
      }
      const lines = deals.map((d) => `#${d.id.slice(0, 8)} — ${d.amount} ${d.currency} — ${d.status}`);
      await bot.sendMessage(chatId, `Ваши сделки:\n\n${lines.join('\n')}`);
      return;
    }

    if (data === 'balance') {
      await bot.sendMessage(
        chatId,
        `Ваш баланс:\nUSDT: ${user.balanceUsdt.toFixed(2)}\nTON: ${user.balanceTon.toFixed(4)}`
      );
      return;
    }

    if (data.startsWith('role_')) {
      const role = data.replace('role_', '') as 'SELLER' | 'BUYER';
      setUserState(userId, { action: 'create_deal_currency', payload: { role } });
      await bot.sendMessage(chatId, 'Выберите валюту сделки:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'USDT TRC20', callback_data: 'currency_USDT' }],
            [{ text: 'TON', callback_data: 'currency_TON' }],
          ],
        },
      });
      return;
    }

    if (data.startsWith('currency_')) {
      const currency = data.replace('currency_', '') as 'USDT' | 'TON';
      const state = getUserState(userId);
      setUserState(userId, {
        action: 'create_deal_amount',
        payload: { ...(state?.payload as object), currency },
      });
      await bot.sendMessage(chatId, `Сделка в ${currency}. Введите сумму (например, 100):`);
      return;
    }

    if (data.startsWith('deal:')) {
      const [, dealId, action] = data.split(':');
      const deal = await getDeal(dealId);
      if (!deal) {
        await bot.sendMessage(chatId, 'Сделка не найдена.');
        return;
      }

      if (action === 'seller_delivered' && getSellerId(deal) === user.id) {
        const updated = await markItemDelivered(deal.id, user.id);
        const buyer = getBuyerId(updated) === updated.creatorId ? updated.creator : updated.participant;
        await bot.sendMessage(
          chatId,
          `Вы отметили товар как переданный по сделке *#${updated.id}*. Ожидайте подтверждения покупателя.`,
          { parse_mode: 'Markdown' }
        );
        if (buyer) {
          await bot.sendMessage(
            buyer.telegramId.toString(),
            `Продавец отметил сделку *#${updated.id}* как выполненную. Проверьте товар и нажмите «Подтвердить получение».`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: 'Подтвердить получение', callback_data: `deal:${updated.id}:buyer_confirm` }],
                  [{ text: 'Открыть спор', callback_data: `deal:${updated.id}:open_dispute` }],
                ],
              },
            }
          );
        }
      }

      if (action === 'buyer_confirm' && getBuyerId(deal) === user.id) {
        const updated = await confirmDealCompletion(deal.id, user.id);
        const seller = getSellerId(updated) === updated.creatorId ? updated.creator : updated.participant;
        await bot.sendMessage(
          chatId,
          `Сделка *#${updated.id}* завершена. Спасибо!`,
          { parse_mode: 'Markdown' }
        );
        if (seller) {
          await bot.sendMessage(
            seller.telegramId.toString(),
            `Сделка *#${updated.id}* подтверждена покупателем. Средства зачислены на ваш баланс.`,
            { parse_mode: 'Markdown' }
          );
        }
      }

      if (action === 'open_dispute' && getBuyerId(deal) === user.id) {
        setUserState(userId, { action: 'dispute_reason', payload: { dealId: deal.id } });
        await bot.sendMessage(chatId, 'Опишите причину спора:');
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
    const state = getUserState(userId);
    if (!state) return;

    const user = await findOrCreateUser(msg.from!);

    if (state.action === 'create_deal_amount') {
      const amount = parseFloat(msg.text.replace(',', '.'));
      if (Number.isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, 'Введите корректную положительную сумму.');
        return;
      }
      setUserState(userId, {
        action: 'create_deal_description',
        payload: { ...(state.payload as Record<string, unknown>), amount },
      });
      await bot.sendMessage(chatId, 'Введите описание товара/услуги:');
      return;
    }

    if (state.action === 'create_deal_description') {
      const { role, currency, amount } = state.payload as {
        role: 'SELLER' | 'BUYER';
        currency: 'USDT' | 'TON';
        amount: number;
      };
      try {
        const deal = await createDeal({
          creatorId: user.id,
          creatorRole: role,
          amount,
          description: msg.text,
          currency,
        });

        // Generate a unique deposit address for the buyer
        const paymentAddress = currency === 'USDT'
          ? (await generateUsdtTrc20Address()) ?? 'TRON_NOT_CONFIGURED'
          : generateTonAddress() ?? 'TON_NOT_CONFIGURED';

        await setDealPaymentAddress(deal.id, paymentAddress);

        const link = getDealInviteLink(deal.id);
        const roleText = role === 'SELLER' ? 'продавец' : 'покупатель';

        await bot.sendMessage(
          chatId,
          `Сделка *#${deal.id}* создана!\n\n` +
            `*Ваша роль:* ${roleText}\n` +
            `*Валюта:* ${currency}\n` +
            `*Сумма:* ${amount}\n` +
            `*Описание:* ${msg.text}\n\n` +
            `Отправьте эту ссылку второму участнику:\n${link}\n\n` +
            `Адрес для оплаты покупателя: \`${paymentAddress}\``,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await bot.sendMessage(chatId, `Ошибка: ${(err as Error).message}`);
      }
      clearUserState(userId);
      return;
    }

    if (state.action === 'dispute_reason') {
      const { dealId } = state.payload as { dealId: string };
      try {
        const updated = await openDispute(dealId, user.id, msg.text);
        await bot.sendMessage(
          chatId,
          `Спор по сделке *#${updated.id}* открыт. Администратор скоро рассмотрит его.`,
          { parse_mode: 'Markdown' }
        );

        await bot.sendMessage(
          config.adminTelegramId.toString(),
          `Новый спор!\nСделка *#${updated.id}*\nСумма: ${updated.amount} ${updated.currency}\n` +
            `Причина: ${msg.text}\nИспользуйте /disputes`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await bot.sendMessage(chatId, `Ошибка: ${(err as Error).message}`);
      }
      clearUserState(userId);
      return;
    }
  });
}

export function registerPaymentNotificationHandler(bot: TelegramBot): void {
  // Deprecated: use services/paymentWatcher.ts instead.
  console.log('Payment watcher: implement cron/webhook for blockchain deposits');
}
