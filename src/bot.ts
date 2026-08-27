import express from 'express';
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
  console.log('PORT:', config.port);
  console.log('Admin ID:', config.adminTelegramId);

  try {
    initTronWeb();
    console.log('TronWeb initialized');
  } catch (err) {
    console.error('TronWeb init failed (non-critical):', err);
  }

  const app = express();
  app.use(express.json());

  // Healthcheck endpoint for Railway / monitoring
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Healthcheck server listening on port ${config.port}`);
  });

  console.log('Creating Telegram bot...');
  const bot = new TelegramBot(config.botToken, {
    polling: config.webhookUrl ? false : true,
  });

  if (config.webhookUrl) {
    await bot.setWebHook(`${config.webhookUrl}/${config.botToken}`);
  }

  console.log('Registering handlers...');
  registerStartHandler(bot);
  registerCallbackHandler(bot);
  registerMessageHandler(bot);
  registerAdminHandler(bot);
  registerWithdrawalHandler(bot);
  startPaymentWatcher(bot);

  console.log('Escrow bot started');

  // Graceful shutdown
  process.once('SIGINT', () => {
    server.close();
    bot.stopPolling();
  });
  process.once('SIGTERM', () => {
    server.close();
    bot.stopPolling();
  });
}

main().catch((err) => {
  console.error('Bot crashed:', err);
  process.exit(1);
});
