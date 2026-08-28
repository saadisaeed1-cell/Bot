-- CreateEnum
CREATE TYPE "DealCategory" AS ENUM ('GIFTS_NFT', 'STARS_XTR', 'ACCOUNTS', 'DIGITAL_KEYS');

-- AlterEnum
ALTER TYPE "DealStatus" ADD VALUE 'PENDING_TERMS';

-- AlterTable
ALTER TABLE "deals" ADD COLUMN     "category" "DealCategory" NOT NULL DEFAULT 'GIFTS_NFT',
ADD COLUMN     "creator_terms_accepted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "participant_terms_accepted" BOOLEAN NOT NULL DEFAULT false;
