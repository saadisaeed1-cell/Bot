import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { prisma } from '../db';
import { DealStatus } from '@prisma/client';
import { scanEscrowDeposits, isTonConfigured } from './paymentService';
import { confirmPayment, getBuyerId, getSellerId } from './dealService';
import { MENU_BUTTON } from '../utils/messageTracker';

/**
 * Polls TonCenter once per cycle for all deposits to the single escrow wallet,
 * matches them against pending deals by memo (deal code), and confirms payments.
 */
export function startPaymentWatcher(bot: TelegramBot): void {
  // Run every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      if (!isTonConfigured()) return;

      const pendingDeals = await prisma.deal.findMany({
        where: { status: DealStatus.PENDING_PAYMENT },
        include: { creator: true, participant: true },
      });
      if (pendingDeals.length === 0) return;

      const memos = pendingDeals.map((d) => d.code);
      const deposits = await scanEscrowDeposits(memos);

      for (const deal of pendingDeals) {
        const deposit = deposits[deal.code];
        if (!deposit) continue;
        // Currency must match what the deal expects.
        if (deposit.currency !== deal.currency) continue;
        if (deposit.amount < deal.amount.toNumber()) continue;

        try {
          const updated = await confirmPayment(deal.id, deposit.txHash, deposit.amount);
          const buyer = getBuyerId(updated) === updated.creatorId ? updated.creator : updated.participant;
          const seller = getSellerId(updated) === updated.creatorId ? updated.creator : updated.participant;

          if (buyer) {
            await bot.sendMessage(
              buyer.telegramId.toString(),
              `💰 Оплата сделки *#${updated.code}* подтверждена. Средства заморожены в эскроу.\n\n` +
                `Ожидайте передачи товара/услуги от продавца.`,
              { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
            );
          }

          if (seller) {
            await bot.sendMessage(
              seller.telegramId.toString(),
              `💰 Покупатель оплатил сделку *#${updated.code}*. Средства заморожены.\n\n` +
                `Теперь передайте товар/услугу и нажмите «Товар передан».`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '📦 Товар передан', callback_data: `deal:${updated.id}:seller_delivered` }],
                    [MENU_BUTTON],
                  ],
                },
              }
            );
          }
        } catch (err) {
          // confirmPayment throws if the deal is not in PENDING_PAYMENT anymore — fine.
          console.error(`Payment watcher error for deal ${deal.id}:`, err);
        }
      }
    } catch (err) {
      console.error('Payment watcher cycle error:', err);
    }
  });
}
