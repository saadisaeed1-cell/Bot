import TelegramBot from 'node-telegram-bot-api';

// Shared "back to main menu" button used across every screen so the user
// always has a way to return to the home screen.
export const MENU_BUTTON: TelegramBot.InlineKeyboardButton = {
  text: '⬅️ В меню',
  callback_data: 'main_menu',
};

// Tracks the last bot message sent to a given chat so it can be deleted
// before the next one is sent. This keeps the chat clean (only the current
// menu/prompt is visible) instead of piling up old messages.
const lastMessageId = new Map<number, number>();

// Tracks recent user messages so we can delete them after they are processed.
const recentUserMessageIds = new Map<number, number[]>();
const MAX_TRACKED_USER_MESSAGES = 10;

async function safeDeleteMessage(bot: TelegramBot, chatId: number, messageId?: number): Promise<void> {
  if (!messageId) return;
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch {
    // Message may already be deleted, too old (>48h), or not deletable — ignore.
  }
}

export async function sendTrackedMessage(
  bot: TelegramBot,
  chatId: number | string,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<TelegramBot.Message> {
  const key = Number(chatId);

  // Delete the previous bot message in this chat.
  const prevId = lastMessageId.get(key);
  if (prevId) {
    await safeDeleteMessage(bot, key, prevId);
  }

  // Also delete recent user messages that were sent before this new bot message.
  const userIds = recentUserMessageIds.get(key) ?? [];
  for (const id of userIds) {
    await safeDeleteMessage(bot, key, id);
  }
  recentUserMessageIds.delete(key);

  const sent = await bot.sendMessage(chatId, text, options);
  lastMessageId.set(key, sent.message_id);
  return sent;
}

export function clearTrackedMessage(chatId: number | string): void {
  lastMessageId.delete(Number(chatId));
}

export function trackUserMessage(chatId: number | string, messageId: number): void {
  const key = Number(chatId);
  const ids = recentUserMessageIds.get(key) ?? [];
  ids.push(messageId);
  if (ids.length > MAX_TRACKED_USER_MESSAGES) ids.shift();
  recentUserMessageIds.set(key, ids);
}

export async function deleteUserMessages(
  bot: TelegramBot,
  chatId: number | string
): Promise<void> {
  const key = Number(chatId);
  const ids = recentUserMessageIds.get(key) ?? [];
  for (const id of ids) {
    await safeDeleteMessage(bot, key, id);
  }
  recentUserMessageIds.delete(key);
}
