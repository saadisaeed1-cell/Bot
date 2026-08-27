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

async function main(): Promise<void> {
  initTronWeb();

  const app = express();
  app.use(express.json());

  // Healthcheck endpoint for Railway / monitoring
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.listen(config.port, () => {
    console.log(`Healthcheck server listening on port ${config.port}`);
  });

  const bot = new TelegramBot(config.botToken, {
    polling: config.webhookUrl ? false : true,
  });

  if (config.webhookUrl) {
    await bot.setWebHook(`${config.webhookUrl}/${config.botToken}`);
  }

  registerStartHandler(bot);
  registerCallbackHandler(bot);
  registerMessageHandler(bot);
  registerAdminHandler(bot);
  registerWithdrawalHandler(bot);
  startPaymentWatcher(bot);

  console.log('Escrow bot started');

  // Graceful shutdown
  process.once('SIGINT', () => bot.stopPolling());
  process.once('SIGTERM', () => bot.stopPolling());
}

main().catch((err) => {
  console.error('Bot crashed:', err);
  process.exit(1);
});
