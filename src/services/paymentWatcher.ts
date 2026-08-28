import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import { prisma } from '../db';
import { DealStatus } from '@prisma/client';
import { verifyUsdtTrc20Payment } from './paymentService';
import { confirmPayment, getBuyerId, getSellerId } from './dealService';
import { MENU_BUTTON } from '../utils/messageTracker';

/**
 * Scans deals in PENDING_PAYMENT status and verifies on-chain deposits.
 * In production, prefer webhooks from TronGrid/TonCenter over polling.
 */
export function startPaymentWatcher(bot: TelegramBot): void {
  // Run every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    const pendingDeals = await prisma.deal.findMany({
      where: { status: DealStatus.PENDING_PAYMENT, paymentAddress: { not: null } },
      include: { creator: true, participant: true },
    });

    for (const deal of pendingDeals) {
      if (!deal.paymentAddress) continue;

      try {
        const result =
          deal.currency === 'USDT'
            ? await verifyUsdtTrc20Payment(deal.paymentAddress, deal.amount.toNumber())
            : { verified: false, amount: 0 };

        if (result.verified && result.txHash) {
          const updated = await confirmPayment(deal.id, result.txHash, result.amount);
          const buyer = getBuyerId(updated) === updated.creatorId ? updated.creator : updated.participant;
          const seller = getSellerId(updated) === updated.creatorId ? updated.creator : updated.participant;

          if (buyer) {
            await bot.sendMessage(
              buyer.telegramId.toString(),
              `Оплата сделки *#${updated.id}* подтверждена. Средства заморожены в эскроу.\n\n` +
                `Ожидайте передачи товара/услуги от продавца.`,
              { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
            );
          }

          if (seller) {
            await bot.sendMessage(
              seller.telegramId.toString(),
              `Покупатель оплатил сделку *#${updated.id}*. Средства заморожены.\n\n` +
                `Передайте товар/услугу и нажмите «Товар передан».`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: 'Товар передан', callback_data: `deal:${updated.id}:seller_delivered` }],
                    [MENU_BUTTON],
                  ],
                },
              }
            );
          }
        }
      } catch (err) {
        console.error(`Payment watcher error for deal ${deal.id}:`, err);
      }
    }
  });
}
