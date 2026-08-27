import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { getPendingDisputes, resolveDispute, getDeal, dealUserIds } from '../services/dealService';

function isAdmin(telegramId: number): boolean {
  return telegramId === config.adminTelegramId;
}

export function registerAdminHandler(bot: TelegramBot): void {
  bot.onText(/\/disputes/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from!.id)) {
      await bot.sendMessage(chatId, 'Доступ запрещен.');
      return;
    }

    const disputes = await getPendingDisputes();
    if (disputes.length === 0) {
      await bot.sendMessage(chatId, 'Нет открытых споров.');
      return;
    }

    for (const deal of disputes) {
      const { sellerId, buyerId } = dealUserIds(deal);
      const seller = sellerId === deal.creatorId ? deal.creator : deal.participant;
      const buyer = buyerId === deal.creatorId ? deal.creator : deal.participant;

      await bot.sendMessage(
        chatId,
        `Спор *#${deal.id}*\n` +
          `Сумма: ${deal.amount} ${deal.currency}\n` +
          `Продавец: ${seller?.firstName ?? '?'} (ID ${seller?.telegramId ?? '?'})\n` +
          `Покупатель: ${buyer?.firstName ?? '?'} (ID ${buyer?.telegramId ?? '?'})\n` +
          `Причина: ${deal.disputeReason ?? 'не указана'}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Отдать продавцу', callback_data: `admin:resolve:${deal.id}:seller` },
                { text: 'Вернуть покупателю', callback_data: `admin:resolve:${deal.id}:buyer` },
              ],
            ],
          },
        }
      );
    }
  });

  bot.onText(/\/deal (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from!.id)) {
      await bot.sendMessage(chatId, 'Доступ запрещен.');
      return;
    }

    const dealId = match![1].trim();
    const deal = await getDeal(dealId);
    if (!deal) {
      await bot.sendMessage(chatId, 'Сделка не найдена.');
      return;
    }

    const { sellerId, buyerId } = dealUserIds(deal);
    const seller = sellerId === deal.creatorId ? deal.creator : deal.participant;
    const buyer = buyerId === deal.creatorId ? deal.creator : deal.participant;

    await bot.sendMessage(
      chatId,
      `Сделка *#${deal.id}*\n` +
        `Статус: ${deal.status}\n` +
        `Сумма: ${deal.amount} ${deal.currency}\n` +
        `Комиссия: ${deal.commissionPercent}%\n` +
        `Продавец: ${seller?.telegramId ?? '—'}\n` +
        `Покупатель: ${buyer?.telegramId ?? '—'}\n` +
        `TX: ${deal.txHash ?? '—'}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from!.id)) {
      await bot.sendMessage(chatId, 'Доступ запрещен.');
      return;
    }

    const { prisma } = await import('../db');
    const totalDeals = await prisma.deal.count();
    const completed = await prisma.deal.count({ where: { status: 'COMPLETED' } });
    const disputes = await prisma.deal.count({ where: { status: 'DISPUTE' } });

    await bot.sendMessage(
      chatId,
      `Статистика:\n` +
        `Всего сделок: ${totalDeals}\n` +
        `Завершено: ${completed}\n` +
        `Споров: ${disputes}`
    );
  });

  bot.on('callback_query', async (query) => {
    const data = query.data!;
    if (!data.startsWith('admin:resolve:')) return;

    const [, , dealId, winner] = data.split(':');
    if (!isAdmin(query.from.id)) {
      await bot.answerCallbackQuery(query.id, { text: 'Доступ запрещен.' });
      return;
    }

    await bot.answerCallbackQuery(query.id);

    try {
      const updated = await resolveDispute(dealId, winner as 'buyer' | 'seller');
      await bot.sendMessage(
        query.message!.chat.id,
        `Спор *#${updated.id}* разрешен в пользу ${winner === 'seller' ? 'продавца' : 'покупателя'}.`,
        { parse_mode: 'Markdown' }
      );

      const { sellerId, buyerId } = dealUserIds(updated);
      const seller = sellerId === updated.creatorId ? updated.creator : updated.participant;
      const buyer = buyerId === updated.creatorId ? updated.creator : updated.participant;

      if (seller) {
        await bot.sendMessage(
          seller.telegramId.toString(),
          `Спор по сделке *#${updated.id}* разрешен.`,
          { parse_mode: 'Markdown' }
        );
      }
      if (buyer) {
        await bot.sendMessage(
          buyer.telegramId.toString(),
          `Спор по сделке *#${updated.id}* разрешен.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      await bot.sendMessage(
        query.message!.chat.id,
        `Ошибка: ${(err as Error).message}`
      );
    }
  });
}
