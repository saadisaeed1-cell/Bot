import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { prisma } from '../db';

const DISCLAIMER_TEXT =
  '⚠️ *ВНИМАНИЕ!*\n' +
  'Все обсуждения условий, передача файлов, логинов, паролей и договоренности ' +
  'должны происходить СТРОГО в этом топике.\n\n' +
  'Если обсуждение или передача данных будет происходить в личных сообщениях (ЛС), ' +
  'страховка гаранта сгорает, и в случае скама бот не несет ответственности.';

// Pending invitations: telegramUserId -> { dealId, topicId }
// Used to send the direct topic link in PM once the user actually joins the group.
const pendingTopicLinks = new Map<
  number,
  { dealId: string; code: string; topicId: number }
>();

export function isForumConfigured(): boolean {
  return Boolean(config.forumGroupChatId);
}

export async function createDealTopic(
  bot: TelegramBot,
  dealId: string,
  code: string
): Promise<number | null> {
  if (!isForumConfigured()) return null;
  const chatId = config.forumGroupChatId as string;

  try {
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
 * Registers a pending topic link for a user. When the user joins the forum group,
 * sendPendingTopicLink() should be called to deliver the direct topic URL via PM.
 */
export function registerPendingTopicLink(
  telegramUserId: number,
  dealId: string,
  code: string,
  topicId: number
): void {
  pendingTopicLinks.set(telegramUserId, { dealId, code, topicId });
}

export function hasPendingTopicLink(telegramUserId: number): boolean {
  return pendingTopicLinks.has(telegramUserId);
}

/**
 * If the user has a pending topic link, send them the direct topic URL in PM.
 * Should be called on chat_member update when status becomes member/administrator/creator.
 */
export async function sendPendingTopicLink(
  bot: TelegramBot,
  telegramUserId: number
): Promise<void> {
  const pending = pendingTopicLinks.get(telegramUserId);
  if (!pending) return;

  const link = getTopicDirectLink(pending.topicId);
  pendingTopicLinks.delete(telegramUserId);
  if (!link) return;

  try {
    await bot.sendMessage(
      telegramUserId,
      `✅ Вы вступили в группу сделки #${pending.code}.\n\n` +
        `💬 Вот ссылка прямо в ваш изолированный чат сделки:\n${link}\n\n` +
        `Все обсуждения и передача данных — только там!`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Failed to send pending topic link:', err);
  }
}

/**
 * Returns a one-time invite link for the forum group and registers the user so
 * the direct topic link is sent via PM once they join.
 */
export async function getDealChatLink(
  bot: TelegramBot,
  telegramUserId: number,
  topicId: number,
  code: string,
  dealId: string
): Promise<string | null> {
  if (!isForumConfigured()) return null;

  try {
    const member = await bot.getChatMember(config.forumGroupChatId as string, telegramUserId);
    if (['member', 'administrator', 'creator'].includes(member.status)) {
      return getTopicDirectLink(topicId);
    }
  } catch {
    // Not a member yet — fall back to a one-time invite below.
  }

  const invite = await createOneTimeGroupInvite(bot, code);
  if (invite) {
    registerPendingTopicLink(telegramUserId, dealId, code, topicId);
  }
  return invite ?? getTopicDirectLink(topicId);
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
