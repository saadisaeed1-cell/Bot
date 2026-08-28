import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  botToken: requireEnv('BOT_TOKEN'),
  adminTelegramId: Number(requireEnv('ADMIN_TELEGRAM_ID')),
  databaseUrl: requireEnv('DATABASE_URL'),
  serviceFeePercent: Number(process.env.SERVICE_FEE_PERCENT ?? '3'),
  port: Number(process.env.PORT ?? '3000'),
  webhookUrl: process.env.WEBHOOK_URL,
  tron: {
    fullNode: process.env.TRON_FULL_NODE ?? 'https://api.trongrid.io',
    solidityNode: process.env.TRON_SOLIDITY_NODE ?? 'https://api.trongrid.io',
    eventServer: process.env.TRON_EVENT_SERVER ?? 'https://api.trongrid.io',
    apiKey: process.env.TRON_API_KEY,
    escrowPrivateKey: process.env.TRON_ESCROW_PRIVATE_KEY,
    usdtContract: process.env.USDT_TRC20_CONTRACT ?? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  },
  ton: {
    endpoint: process.env.TON_ENDPOINT ?? 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TON_API_KEY,
    escrowMnemonic: process.env.TON_ESCROW_MNEMONIC,
  },
  // Private supergroup with Topics enabled, used as an isolated chat room per deal.
  forumGroupChatId: process.env.FORUM_GROUP_CHAT_ID,
  // Optional: set only if the group is public (has a @username), enables direct topic links.
  forumGroupUsername: process.env.FORUM_GROUP_USERNAME,
};
