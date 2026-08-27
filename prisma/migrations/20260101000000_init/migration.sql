-- CreateEnum
CREATE TYPE "DealRole" AS ENUM ('SELLER', 'BUYER');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('PENDING_PARTICIPANT', 'PENDING_PAYMENT', 'FUNDS_FROZEN', 'DELIVERY_PENDING', 'COMPLETED', 'DISPUTE', 'REFUNDED', 'RELEASED_TO_SELLER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'ESCROW_HOLD', 'ESCROW_RELEASE', 'ESCROW_REFUND', 'WITHDRAWAL', 'FEE');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "balance_usdt" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "balance_ton" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "creator_id" INTEGER NOT NULL,
    "creator_role" "DealRole" NOT NULL DEFAULT 'SELLER',
    "participant_id" INTEGER,
    "amount" DECIMAL(18,8) NOT NULL,
    "commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "status" "DealStatus" NOT NULL DEFAULT 'PENDING_PARTICIPANT',
    "description" TEXT NOT NULL,
    "payment_address" TEXT,
    "tx_hash" TEXT,
    "seller_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "buyer_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "dispute_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "deal_id" TEXT,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "tx_hash" TEXT,
    "status" "TxStatus" NOT NULL DEFAULT 'COMPLETED',
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_status_logs" (
    "id" SERIAL NOT NULL,
    "deal_id" TEXT NOT NULL,
    "old_status" "DealStatus" NOT NULL,
    "new_status" "DealStatus" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE INDEX "users_telegram_id_idx" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "deals_tx_hash_key" ON "deals"("tx_hash");

-- CreateIndex
CREATE INDEX "deals_status_idx" ON "deals"("status");

-- CreateIndex
CREATE INDEX "deals_creator_id_idx" ON "deals"("creator_id");

-- CreateIndex
CREATE INDEX "deals_participant_id_idx" ON "deals"("participant_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_idx" ON "transactions"("user_id");

-- CreateIndex
CREATE INDEX "transactions_deal_id_idx" ON "transactions"("deal_id");

-- CreateIndex
CREATE INDEX "deal_status_logs_deal_id_idx" ON "deal_status_logs"("deal_id");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_status_logs" ADD CONSTRAINT "deal_status_logs_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

