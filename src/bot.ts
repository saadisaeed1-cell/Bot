import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { initTronWeb } from './services/paymentService';
import { startPaymentWatcher } from './services/paymentWatcher';
import {
  registerStartHandler,
  registerCallbackHandler,
  registerMessageHandler,
} from './handlers/startHandler';
import { registerAdminHandler } from './handlers/adminHandler';
import { registerWithdrawalHandler } from './handlers/withdrawalHandler';

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

async function main(): Promise<void> {
  console.log('Starting bot...');

  try {
    initTronWeb();
  } catch (err) {
    console.error('TronWeb init failed (non-critical):', err);
  }

  const bot = new TelegramBot(config.botToken, { polling: true });

  // Debug helper: /chatid replies with the chat id directly in the chat,
  // so it's visible right in Telegram without digging through Railway logs.
  bot.onText(/^\/chatid$/, (msg) => {
    console.log(
      `[chat-id] type=${msg.chat.type} id=${msg.chat.id} title=${msg.chat.title ?? ''}`
    );
    bot
      .sendMessage(msg.chat.id, `🆔 Chat ID этого чата: \`${msg.chat.id}\``, {
        parse_mode: 'Markdown',
      })
      .catch((err) => console.error('Failed to send chat id reply:', err));
  });

  registerStartHandler(bot);
  registerCallbackHandler(bot);
  registerMessageHandler(bot);
  registerAdminHandler(bot);
  registerWithdrawalHandler(bot);
  startPaymentWatcher(bot);

  console.log('Escrow bot started');

  process.once('SIGINT', () => bot.stopPolling());
  process.once('SIGTERM', () => bot.stopPolling());
}

main().catch((err) => {
  console.error('Bot crashed:', err);
  process.exit(1);
});
