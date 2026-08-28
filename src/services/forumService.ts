import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { prisma } from '../db';

const DISCLAIMER_TEXT =
  '⚠️ *ВНИМАНИЕ!*\n' +
  'Все обсуждения условий, передача файлов, логинов, паролей и договоренности ' +
  'должны происходить СТРОГО в этом топике.\n\n' +
  'Если обсуждение или передача данных будет происходить в личных сообщениях (ЛС), ' +
  'страховка гаранта сгорает, и в случае скама бот не несет ответственности.';

export function isForumConfigured(): boolean {
  return Boolean(config.forumGroupChatId);
}

/**
 * Creates an isolated Forum Topic for a deal, posts and pins the mandatory
 * disclaimer inside it, and stores the resulting topic id on the deal row.
 * Returns null (and logs) if the forum group is not configured or the call fails,
 * so deal creation never gets blocked by a Telegram/API issue.
 */
export async function createDealTopic(
  bot: TelegramBot,
  dealId: string,
  code: string
): Promise<number | null> {
  if (!isForumConfigured()) return null;
  const chatId = config.forumGroupChatId as string;

  try {
    // The @types package incorrectly declares this as Promise<boolean>; the actual
    // Telegram API (and the underlying implementation) resolves with a ForumTopic object.
    const topic = (await bot.createForumTopic(chatId, `Сделка #${code}`)) as unknown as {
      message_thread_id: number;
    };
    const topicId = topic.message_thread_id;

    await prisma.deal.update({
      where: { id: dealId },
      data: { forumTopicId: topicId },
    });

    try {
      const disclaimer = await bot.sendMessage(chatId, DISCLAIMER_TEXT, {
        message_thread_id: topicId,
        parse_mode: 'Markdown',
      });
      await bot.pinChatMessage(chatId, disclaimer.message_id);
    } catch (err) {
      console.error('Failed to post/pin deal topic disclaimer:', err);
    }

    return topicId;
  } catch (err) {
    console.error('Failed to create deal forum topic:', err);
    return null;
  }
}

/**
 * Direct t.me link straight into a topic. Only reliably opens for users who
 * are already members of the group (or when the group is public).
 */
export function getTopicDirectLink(topicId: number): string | null {
  if (!config.forumGroupChatId) return null;
  if (config.forumGroupUsername) {
    return `https://t.me/${config.forumGroupUsername}/${topicId}`;
  }
  const idStr = config.forumGroupChatId.toString();
  const internalId = idStr.startsWith('-100') ? idStr.slice(4) : idStr.replace('-', '');
  return `https://t.me/c/${internalId}/${topicId}`;
}

export async function createOneTimeGroupInvite(
  bot: TelegramBot,
  code: string
): Promise<string | null> {
  if (!isForumConfigured()) return null;
  try {
    const link = await bot.createChatInviteLink(config.forumGroupChatId as string, {
      name: `Сделка #${code}`,
      member_limit: 1,
    });
    return link.invite_link;
  } catch (err) {
    console.error('Failed to create one-time group invite link:', err);
    return null;
  }
}

/**
 * Resolves the best possible link to send a user into the deal's topic:
 * a direct topic link if they're already a group member, otherwise a fresh
 * one-time invite link to the group.
 */
export async function getDealChatLink(
  bot: TelegramBot,
  telegramUserId: number,
  topicId: number,
  code: string
): Promise<string | null> {
  if (!isForumConfigured()) return null;

  try {
    const member = await bot.getChatMember(config.forumGroupChatId as string, telegramUserId);
    if (['member', 'administrator', 'creator'].includes(member.status)) {
      return getTopicDirectLink(topicId);
    }
  } catch {
    // Not a member yet or lookup failed — fall back to a one-time invite below.
  }

  return (await createOneTimeGroupInvite(bot, code)) ?? getTopicDirectLink(topicId);
}

export async function notifyDisputeInTopic(
  bot: TelegramBot,
  topicId: number,
  adminTelegramId: number,
  code: string,
  reason: string
): Promise<void> {
  if (!isForumConfigured()) return;
  try {
    await bot.sendMessage(
      config.forumGroupChatId as string,
      `🚨 *Открыт спор по сделке #${code}!*\n\n` +
        `Причина: ${reason}\n\n` +
        `[Администратор](tg://user?id=${adminTelegramId}), требуется ваше участие.`,
      { message_thread_id: topicId, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Failed to notify dispute in topic:', err);
  }
}

export async function notifyTopicOnCancel(
  bot: TelegramBot,
  topicId: number,
  code: string
): Promise<void> {
  if (!isForumConfigured()) return;
  try {
    await bot.sendMessage(config.forumGroupChatId as string, `❌ Сделка #${code} отменена.`, {
      message_thread_id: topicId,
    });
  } catch (err) {
    console.error('Failed to notify topic on cancel:', err);
  }
}
