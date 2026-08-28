import { DealCategory, DealRole } from '@prisma/client';
import { config } from '../config';

export const DEAL_CATEGORIES: { value: DealCategory; label: string; emoji: string }[] = [
  { value: 'GIFTS_NFT', label: 'Telegram Подарки / NFT', emoji: '🎁' },
  { value: 'STARS_XTR', label: 'Telegram Звезды (XTR)', emoji: '⭐' },
  { value: 'ACCOUNTS', label: 'Аккаунты / Каналы / Чаты', emoji: '👤' },
  { value: 'DIGITAL_KEYS', label: 'Цифровые ключи / Подписки / Софт', emoji: '🔑' },
];

export function getCategoryLabel(category: DealCategory): string {
  const found = DEAL_CATEGORIES.find((c) => c.value === category);
  return found ? `${found.emoji} ${found.label}` : category;
}

const ROLE_TERMS: Record<DealCategory, Record<DealRole, string>> = {
  GIFTS_NFT: {
    SELLER:
      'Гарантирует наличие подарка на аккаунте и обязуется передать его через официальный интерфейс Telegram / бизнес-соединение после подтверждения холдирования средств. Запрещено отменять передачу.',
    BUYER:
      'Подтверждает активность аккаунта для получения подарков и обязуется своевременно подтвердить получение.',
  },
  STARS_XTR: {
    SELLER:
      'Обязуется перевести точное количество звезд на служебный счет/инвойс бота. Средства холдируются до завершения обмена.',
    BUYER:
      'Подтверждает корректность суммы и обязуется не использовать мошеннические платежные методы.',
  },
  ACCOUNTS: {
    SELLER:
      'Гарантирует полную передачу прав (смену почты, 2FA, удаление старых привязок). Попытка восстановления проданного аккаунта/канала расценивается как мошенничество, средства аннулируются в пользу покупателя.',
    BUYER:
      'Обязуется в течение регламентированного времени полностью сменить все данные на свои и подтвердить сделку (либо открыть спор).',
  },
  DIGITAL_KEYS: {
    SELLER: 'Гарантирует валидность и работоспособность товара на заявленный срок.',
    BUYER:
      'Обязуется проверить товар сразу после получения. При невалидности — открыть спор до истечения таймера.',
  },
};

export function getRoleTerms(category: DealCategory, role: DealRole): string {
  return ROLE_TERMS[category][role];
}

export function buildTermsMessage(category: DealCategory, role: DealRole): string {
  const roleLabel = role === 'SELLER' ? 'продавца' : 'покупателя';
  return (
    `📜 *Правила сделки*\n` +
    `Категория: ${getCategoryLabel(category)}\n\n` +
    `*Обязательства ${roleLabel}:*\n${getRoleTerms(category, role)}\n\n` +
    `*Общие правила арбитража:*\n` +
    `• В случае спора решение администратора (гаранта) является окончательным.\n` +
    `• Комиссия сервиса составляет ${config.serviceFeePercent}% и удерживается при успешном завершении сделки.\n\n` +
    `Нажимая «✅ Принимаю условия», вы подтверждаете согласие с правилами.`
  );
}
