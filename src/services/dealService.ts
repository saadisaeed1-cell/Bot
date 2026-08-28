import { Deal, DealCategory, DealStatus, Prisma, TransactionType, User } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';

let adminUserCache: User | null = null;

export async function getAdminUser(): Promise<User> {
  if (adminUserCache) return adminUserCache;
  adminUserCache = await prisma.user.findUnique({
    where: { telegramId: BigInt(config.adminTelegramId) },
  });
  if (!adminUserCache) {
    adminUserCache = await prisma.user.create({
      data: { telegramId: BigInt(config.adminTelegramId) },
    });
  }
  return adminUserCache;
}

export function getSellerId(deal: Deal): number {
  return deal.creatorRole === 'SELLER' ? deal.creatorId : (deal.participantId ?? 0);
}

export function getBuyerId(deal: Deal): number {
  return deal.creatorRole === 'BUYER' ? deal.creatorId : (deal.participantId ?? 0);
}

export function dealUserIds(deal: Deal): { sellerId: number; buyerId: number } {
  return { sellerId: getSellerId(deal), buyerId: getBuyerId(deal) };
}

export type DealWithUsers = Deal & {
  creator: User;
  participant: User | null;
};

export async function findOrCreateUser(telegramUser: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): Promise<User> {
  return prisma.user.upsert({
    where: { telegramId: telegramUser.id },
    update: {
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
    },
    create: {
      telegramId: telegramUser.id,
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
    },
  });
}

export function getDealInviteLink(dealId: string): string {
  return `https://t.me/${process.env.BOT_USERNAME || 'your_bot'}?start=deal_${dealId}`;
}

export async function createDeal(params: {
  creatorId: number;
  creatorRole: 'SELLER' | 'BUYER';
  category: DealCategory;
  amount: number;
  description: string;
  currency: 'USDT' | 'TON';
}): Promise<Deal> {
  const amount = new Prisma.Decimal(params.amount);
  if (amount.lessThanOrEqualTo(0)) throw new Error('Amount must be positive');

  return prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({
      data: {
        creatorId: params.creatorId,
        creatorRole: params.creatorRole,
        category: params.category,
        amount,
        description: params.description,
        currency: params.currency,
        commissionPercent: new Prisma.Decimal(config.serviceFeePercent),
        status: DealStatus.PENDING_PARTICIPANT,
        creatorTermsAccepted: true,
      },
    });

    await tx.dealStatusLog.create({
      data: {
        dealId: deal.id,
        oldStatus: DealStatus.PENDING_PARTICIPANT,
        newStatus: DealStatus.PENDING_PARTICIPANT,
        note: `Deal created by ${params.creatorRole}, category ${params.category}`,
      },
    });

    return deal;
  });
}

export async function joinDeal(dealId: string, participantId: number): Promise<DealWithUsers> {
  return prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        include: { creator: true, participant: true },
      });

      if (!deal) throw new Error('Deal not found');
      if (deal.status !== DealStatus.PENDING_PARTICIPANT) {
        throw new Error('Deal is not waiting for a participant');
      }
      if (deal.creatorId === participantId) {
        throw new Error('Creator cannot join their own deal');
      }

      const updated = await tx.deal.update({
        where: { id: dealId, status: DealStatus.PENDING_PARTICIPANT },
        data: {
          participantId,
          status: DealStatus.PENDING_TERMS,
        },
        include: { creator: true, participant: true },
      });

      await tx.dealStatusLog.create({
        data: {
          dealId: deal.id,
          oldStatus: DealStatus.PENDING_PARTICIPANT,
          newStatus: DealStatus.PENDING_TERMS,
          note: `Participant ${participantId} joined`,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function acceptParticipantTerms(
  dealId: string,
  participantId: number
): Promise<DealWithUsers> {
  return prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        include: { creator: true, participant: true },
      });

      if (!deal) throw new Error('Deal not found');
      if (deal.status !== DealStatus.PENDING_TERMS) {
        throw new Error('Deal is not waiting for terms acceptance');
      }
      if (deal.participantId !== participantId) {
        throw new Error('Only the invited participant can accept terms');
      }

      const updated = await tx.deal.update({
        where: { id: dealId, status: DealStatus.PENDING_TERMS },
        data: {
          participantTermsAccepted: true,
          status: DealStatus.PENDING_PAYMENT,
        },
        include: { creator: true, participant: true },
      });

      await tx.dealStatusLog.create({
        data: {
          dealId: deal.id,
          oldStatus: DealStatus.PENDING_TERMS,
          newStatus: DealStatus.PENDING_PAYMENT,
          note: `Participant ${participantId} accepted terms`,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function setDealPaymentAddress(
  dealId: string,
  paymentAddress: string
): Promise<DealWithUsers> {
  return prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findUnique({
      where: { id: dealId },
      include: { creator: true, participant: true },
    });
    if (!deal) throw new Error('Deal not found');
    if (deal.status !== DealStatus.PENDING_PAYMENT) {
      throw new Error('Deal is not waiting for payment');
    }

    return tx.deal.update({
      where: { id: dealId },
      data: { paymentAddress },
      include: { creator: true, participant: true },
    });
  });
}

export async function confirmPayment(
  dealId: string,
  txHash: string,
  actualAmount: number
): Promise<DealWithUsers> {
  return prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        include: { creator: true, participant: true },
      });
      if (!deal) throw new Error('Deal not found');
      if (deal.status !== DealStatus.PENDING_PAYMENT) {
        throw new Error('Deal is not waiting for payment');
      }
      if (!deal.participantId) throw new Error('Participant not found');

      const received = new Prisma.Decimal(actualAmount);
      if (received.lessThan(deal.amount)) {
        throw new Error(`Insufficient payment. Expected ${deal.amount}, got ${received}`);
      }

      const buyerId = getBuyerId(deal);
      if (!buyerId) throw new Error('Buyer not assigned');

      const updated = await tx.deal.update({
        where: { id: dealId, status: DealStatus.PENDING_PAYMENT },
        data: {
          status: DealStatus.FUNDS_FROZEN,
          txHash,
        },
        include: { creator: true, participant: true },
      });

      await tx.transaction.create({
        data: {
          userId: buyerId,
          dealId: deal.id,
          type: TransactionType.ESCROW_HOLD,
          amount: deal.amount,
          currency: deal.currency,
          txHash,
          status: 'COMPLETED',
          description: 'Funds frozen in escrow',
        },
      });

      await tx.dealStatusLog.create({
        data: {
          dealId: deal.id,
          oldStatus: DealStatus.PENDING_PAYMENT,
          newStatus: DealStatus.FUNDS_FROZEN,
          note: `Payment confirmed on chain: ${txHash}`,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function markItemDelivered(dealId: string, sellerId: number): Promise<DealWithUsers> {
  return prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        include: { creator: true, participant: true },
      });
      if (!deal) throw new Error('Deal not found');
      if (deal.status !== DealStatus.FUNDS_FROZEN) {
        throw new Error('Funds are not frozen');
      }
      if (getSellerId(deal) !== sellerId) {
        throw new Error('Only seller can mark item as delivered');
      }

      const updated = await tx.deal.update({
        where: { id: dealId, status: DealStatus.FUNDS_FROZEN },
        data: {
          status: DealStatus.DELIVERY_PENDING,
          sellerConfirmed: true,
        },
        include: { creator: true, participant: true },
      });

      await tx.dealStatusLog.create({
        data: {
          dealId: deal.id,
          oldStatus: DealStatus.FUNDS_FROZEN,
          newStatus: DealStatus.DELIVERY_PENDING,
          note: 'Seller marked item/service as delivered',
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function confirmDealCompletion(dealId: string, buyerId: number): Promise<DealWithUsers> {
  return prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        include: { creator: true, participant: true },
      });
      if (!deal) throw new Error('Deal not found');
      if (deal.status !== DealStatus.DELIVERY_PENDING) {
        throw new Error('Deal is not waiting for buyer confirmation');
      }
      if (getBuyerId(deal) !== buyerId) {
        throw new Error('Only buyer can confirm completion');
      }

      const fee = deal.amount.mul(deal.commissionPercent).div(100);
      const sellerAmount = deal.amount.minus(fee);
      const sellerId = getSellerId(deal);
      if (!sellerId) throw new Error('Seller not assigned');

      const adminUser = await getAdminUser();
      const balanceField = deal.currency === 'TON' ? 'balanceTon' : 'balanceUsdt';

      // Atomic balance updates inside the same Serializable transaction
      await tx.$queryRawUnsafe(
        `UPDATE users SET ${balanceField} = ${balanceField} + ${sellerAmount.toFixed(8)} WHERE id = ${sellerId}`
      );

      if (fee.greaterThan(0)) {
        await tx.$queryRawUnsafe(
          `UPDATE users SET ${balanceField} = ${balanceField} + ${fee.toFixed(8)} WHERE id = ${adminUser.id}`
        );
      }

      const updated = await tx.deal.update({
        where: { id: dealId, status: DealStatus.DELIVERY_PENDING },
        data: {
          status: DealStatus.COMPLETED,
          buyerConfirmed: true,
        },
        include: { creator: true, participant: true },
      });

      await tx.transaction.create({
        data: {
          userId: sellerId,
          dealId: deal.id,
          type: TransactionType.ESCROW_RELEASE,
          amount: sellerAmount,
          currency: deal.currency,
          status: 'COMPLETED',
          description: 'Funds released to seller',
        },
      });

      if (fee.greaterThan(0)) {
        await tx.transaction.create({
          data: {
            userId: adminUser.id,
            dealId: deal.id,
            type: TransactionType.FEE,
            amount: fee,
            currency: deal.currency,
            status: 'COMPLETED',
            description: 'Service fee',
          },
        });
      }

      await tx.dealStatusLog.create({
        data: {
          dealId: deal.id,
          oldStatus: DealStatus.DELIVERY_PENDING,
          newStatus: DealStatus.COMPLETED,
          note: `Buyer confirmed completion. Seller received ${sellerAmount} ${deal.currency}, fee ${fee}`,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function openDispute(
  dealId: string,
  userId: number,
  reason: string
): Promise<DealWithUsers> {
  return prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        include: { creator: true, participant: true },
      });
      if (!deal) throw new Error('Deal not found');
      if (deal.status !== DealStatus.FUNDS_FROZEN && deal.status !== DealStatus.DELIVERY_PENDING) {
        throw new Error('Cannot open dispute at this stage');
      }
      const { sellerId, buyerId } = dealUserIds(deal);
      if (sellerId !== userId && buyerId !== userId) {
        throw new Error('Not a deal participant');
      }

      const updated = await tx.deal.update({
        where: {
          id: dealId,
          status: { in: [DealStatus.FUNDS_FROZEN, DealStatus.DELIVERY_PENDING] },
        },
        data: {
          status: DealStatus.DISPUTE,
          disputeReason: reason,
        },
        include: { creator: true, participant: true },
      });

      await tx.dealStatusLog.create({
        data: {
          dealId: deal.id,
          oldStatus: deal.status,
          newStatus: DealStatus.DISPUTE,
          note: `Dispute opened by user ${userId}: ${reason}`,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function resolveDispute(
  dealId: string,
  winner: 'buyer' | 'seller'
): Promise<DealWithUsers> {
  return prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: dealId },
        include: { creator: true, participant: true },
      });
      if (!deal) throw new Error('Deal not found');
      if (deal.status !== DealStatus.DISPUTE) throw new Error('Deal is not in dispute');
      if (!deal.participantId) throw new Error('Participant not found');

      const balanceField = deal.currency === 'TON' ? 'balanceTon' : 'balanceUsdt';
      const adminUser = await getAdminUser();
      const { sellerId, buyerId } = dealUserIds(deal);
      if (!sellerId || !buyerId) throw new Error('Seller or buyer not assigned');

      if (winner === 'seller') {
        const fee = deal.amount.mul(deal.commissionPercent).div(100);
        const sellerAmount = deal.amount.minus(fee);

        await tx.$queryRawUnsafe(
          `UPDATE users SET ${balanceField} = ${balanceField} + ${sellerAmount.toFixed(8)} WHERE id = ${sellerId}`
        );

        await tx.transaction.create({
          data: {
            userId: sellerId,
            dealId: deal.id,
            type: TransactionType.ESCROW_RELEASE,
            amount: sellerAmount,
            currency: deal.currency,
            status: 'COMPLETED',
            description: 'Funds released to seller after dispute resolution',
          },
        });

        if (fee.greaterThan(0)) {
          await tx.$queryRawUnsafe(
            `UPDATE users SET ${balanceField} = ${balanceField} + ${fee.toFixed(8)} WHERE id = ${adminUser.id}`
          );
          await tx.transaction.create({
            data: {
              userId: adminUser.id,
              dealId: deal.id,
              type: TransactionType.FEE,
              amount: fee,
              currency: deal.currency,
              status: 'COMPLETED',
              description: 'Service fee after dispute resolution',
            },
          });
        }
      } else {
        await tx.$queryRawUnsafe(
          `UPDATE users SET ${balanceField} = ${balanceField} + ${deal.amount.toFixed(8)} WHERE id = ${buyerId}`
        );
        await tx.transaction.create({
          data: {
            userId: buyerId,
            dealId: deal.id,
            type: TransactionType.ESCROW_REFUND,
            amount: deal.amount,
            currency: deal.currency,
            status: 'COMPLETED',
            description: 'Funds refunded to buyer after dispute resolution',
          },
        });
      }

      const updated = await tx.deal.update({
        where: { id: dealId, status: DealStatus.DISPUTE },
        data: {
          status: winner === 'seller' ? DealStatus.RELEASED_TO_SELLER : DealStatus.REFUNDED,
        },
        include: { creator: true, participant: true },
      });

      await tx.dealStatusLog.create({
        data: {
          dealId: deal.id,
          oldStatus: DealStatus.DISPUTE,
          newStatus: winner === 'seller' ? DealStatus.RELEASED_TO_SELLER : DealStatus.REFUNDED,
          note: `Dispute resolved in favor of ${winner}`,
        },
      });

      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function getDeal(dealId: string): Promise<DealWithUsers | null> {
  return prisma.deal.findUnique({
    where: { id: dealId },
    include: { creator: true, participant: true },
  });
}

export async function getUserDeals(userId: number): Promise<DealWithUsers[]> {
  return prisma.deal.findMany({
    where: { OR: [{ creatorId: userId }, { participantId: userId }] },
    orderBy: { createdAt: 'desc' },
    include: { creator: true, participant: true },
  });
}

export async function getPendingDisputes(): Promise<DealWithUsers[]> {
  return prisma.deal.findMany({
    where: { status: DealStatus.DISPUTE },
    orderBy: { createdAt: 'desc' },
    include: { creator: true, participant: true },
  });
}
