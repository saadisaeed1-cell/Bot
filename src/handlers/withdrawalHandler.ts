import TelegramBot from 'node-telegram-bot-api';
import { findOrCreateUser } from '../services/dealService';
import { prisma } from '../db';
import { Prisma, TransactionType, TxStatus } from '@prisma/client';
import { sendTrackedMessage, MENU_BUTTON } from '../utils/messageTracker';

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
        await prisma.$transaction(
          async (tx) => {
            const freshUser = await tx.user.findUnique({ where: { id: user.id } });
            if (!freshUser) throw new Error('User not found');

            const balance = state.currency === 'TON' ? freshUser.balanceTon : freshUser.balanceUsdt;
            if (balance.lessThan(requested)) {
              throw new Error('Insufficient balance');
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
                description: `Withdrawal to ${state.address}`,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );

        withdrawState.delete(userId);
        await sendTrackedMessage(
          bot,
          chatId,
          `Заявка на вывод ${state.amount} ${state.currency} на адрес \`${state.address}\` создана.\n` +
            `Администратор обработает её вручную.`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
        );
      } catch (err) {
        await sendTrackedMessage(bot, chatId, `Ошибка: ${(err as Error).message}`, {
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
