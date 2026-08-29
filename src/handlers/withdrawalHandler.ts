import TelegramBot from 'node-telegram-bot-api';
import { findOrCreateUser } from '../services/dealService';
import { prisma } from '../db';
import { Prisma, TransactionType, TxStatus } from '@prisma/client';
import { sendTrackedMessage, MENU_BUTTON, trackUserMessage } from '../utils/messageTracker';
import { sendTon, sendUsdtJetton, isTonConfigured } from '../services/paymentService';

const withdrawState = new Map<number, { currency: 'USDT' | 'TON'; amount: number; address: string }>();

export function clearWithdrawState(userId: number): void {
  withdrawState.delete(userId);
}

export function registerWithdrawalHandler(bot: TelegramBot): void {
  bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await findOrCreateUser(msg.from!);
    await sendTrackedMessage(
      bot,
      chatId,
      `Ваш баланс:\nUSDT: ${user.balanceUsdt.toFixed(2)}\nTON: ${user.balanceTon.toFixed(4)}\n\n` +
        `Выберите валюту для вывода:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'USDT', callback_data: 'withdraw_currency_USDT' }],
            [{ text: 'TON', callback_data: 'withdraw_currency_TON' }],
            [MENU_BUTTON],
          ],
        },
      }
    );
  });

  bot.on('callback_query', async (query) => {
    const data = query.data!;
    const chatId = query.message!.chat.id;
    const userId = query.from.id;

    if (data.startsWith('withdraw_currency_')) {
      const currency = data.replace('withdraw_currency_', '') as 'USDT' | 'TON';
      withdrawState.set(userId, { currency, amount: 0, address: '' });
      await bot.answerCallbackQuery(query.id);
      await sendTrackedMessage(bot, chatId, `Введите сумму для вывода ${currency}:`, {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }

    if (data === 'withdraw_cancel') {
      await bot.answerCallbackQuery(query.id);
      withdrawState.delete(userId);
      await sendTrackedMessage(bot, chatId, 'Вывод отменен.', {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }

    if (data === 'withdraw_confirm') {
      await bot.answerCallbackQuery(query.id);
      const state = withdrawState.get(userId);
      if (!state) return;

      const user = await findOrCreateUser(query.from);
      const balanceField = state.currency === 'TON' ? 'balanceTon' : 'balanceUsdt';
      const requested = new Prisma.Decimal(state.amount);

      try {
        if (!isTonConfigured()) {
          throw new Error('Выплаты не настроены: отсутствует кошелёк бота (TON_ESCROW_MNEMONIC).');
        }

        // 1. Atomically deduct the balance first (prevents double-withdrawal).
        await prisma.$transaction(
          async (tx) => {
            const freshUser = await tx.user.findUnique({ where: { id: user.id } });
            if (!freshUser) throw new Error('User not found');

            const balance = state.currency === 'TON' ? freshUser.balanceTon : freshUser.balanceUsdt;
            if (balance.lessThan(requested)) {
              throw new Error('Недостаточно средств на балансе');
            }

            await tx.$queryRawUnsafe(
              `UPDATE users SET ${balanceField} = ${balanceField} - ${requested.toFixed(8)} WHERE id = ${user.id}`
            );

            await tx.transaction.create({
              data: {
                userId: user.id,
                type: TransactionType.WITHDRAWAL,
                amount: requested,
                currency: state.currency,
                status: TxStatus.PENDING,
                description: `Instant withdrawal to ${state.address}`,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );

        // 2. Send the on-chain payout instantly from the escrow wallet.
        let txHash: string;
        if (state.currency === 'TON') {
          txHash = await sendTon(state.address, state.amount);
        } else {
          txHash = await sendUsdtJetton(state.address, state.amount);
        }

        // 3. Mark the transaction as completed.
        const txRecord = await prisma.transaction.findFirst({
          where: { userId: user.id, type: TransactionType.WITHDRAWAL, status: TxStatus.PENDING },
          orderBy: { createdAt: 'desc' },
        });
        if (txRecord) {
          await prisma.transaction.update({
            where: { id: txRecord.id },
            data: { status: TxStatus.COMPLETED, txHash },
          });
        }

        withdrawState.delete(userId);
        await sendTrackedMessage(
          bot,
          chatId,
          `✅ Вывод *${state.amount} ${state.currency}* на адрес \`${state.address}\` выполнен мгновенно!`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
        );
      } catch (err) {
        // Refund the balance if the on-chain transfer failed after deduction.
        try {
          await prisma.$transaction(
            async (tx) => {
              await tx.$queryRawUnsafe(
                `UPDATE users SET ${balanceField} = ${balanceField} + ${requested.toFixed(8)} WHERE id = ${user.id}`
              );
              const pending = await tx.transaction.findFirst({
                where: { userId: user.id, type: TransactionType.WITHDRAWAL, status: TxStatus.PENDING },
                orderBy: { createdAt: 'desc' },
              });
              if (pending) {
                await tx.transaction.update({
                  where: { id: pending.id },
                  data: { status: TxStatus.FAILED },
                });
              }
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          );
        } catch (refundErr) {
          console.error('Failed to refund balance after failed withdrawal:', refundErr);
        }

        withdrawState.delete(userId);
        await sendTrackedMessage(bot, chatId, `❌ Ошибка вывода: ${(err as Error).message}`, {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
      }
      return;
    }
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = msg.from!.id;
    const chatId = msg.chat.id;
    const state = withdrawState.get(userId);
    if (!state) return;

    if (state.amount === 0) {
      const amount = parseFloat(msg.text.replace(',', '.'));
      if (Number.isNaN(amount) || amount <= 0) {
        await sendTrackedMessage(bot, chatId, 'Введите положительную сумму.', {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      state.amount = amount;
      withdrawState.set(userId, state);
      await sendTrackedMessage(bot, chatId, 'Введите адрес для вывода:', {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }

    if (state.address === '') {
      state.address = msg.text.trim();
      withdrawState.set(userId, state);
      await sendTrackedMessage(
        bot,
        chatId,
        `Подтвердите вывод:\nСумма: ${state.amount} ${state.currency}\nАдрес: ${state.address}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Подтвердить', callback_data: 'withdraw_confirm' }],
              [{ text: 'Отмена', callback_data: 'withdraw_cancel' }],
              [MENU_BUTTON],
            ],
          },
        }
      );
      return;
    }
  });
}
