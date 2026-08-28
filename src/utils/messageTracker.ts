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

export async function sendTrackedMessage(
  bot: TelegramBot,
  chatId: number | string,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<TelegramBot.Message> {
  const key = Number(chatId);
  const prevId = lastMessageId.get(key);
  if (prevId) {
    try {
      await bot.deleteMessage(key, prevId);
    } catch {
      // Message may already be deleted, too old (>48h), or not deletable — ignore.
    }
  }

  const sent = await bot.sendMessage(chatId, text, options);
  lastMessageId.set(key, sent.message_id);
  return sent;
}

export function clearTrackedMessage(chatId: number | string): void {
  lastMessageId.delete(Number(chatId));
}
