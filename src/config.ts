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
  ton: {
    endpoint: process.env.TON_ENDPOINT ?? 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: process.env.TON_API_KEY,
    // 24-word mnemonic for the bot's single TON escrow wallet.
    // All deposits and instant payouts are signed with this wallet.
    escrowMnemonic: process.env.TON_ESCROW_MNEMONIC,
    // Official Tether USD₮ jetton master on TON mainnet.
    usdtMaster:
      process.env.TON_USDT_MASTER ??
      'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  },
  // Private supergroup with Topics enabled, used as an isolated chat room per deal.
  forumGroupChatId: process.env.FORUM_GROUP_CHAT_ID,
  // Optional: set only if the group is public (has a @username), enables direct topic links.
  forumGroupUsername: process.env.FORUM_GROUP_USERNAME,
};
