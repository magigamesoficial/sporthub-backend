-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'BANNED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "users" ADD COLUMN "moderationReason" TEXT;
ALTER TABLE "users" ADD COLUMN "moderatedAt" TIMESTAMP(3);
