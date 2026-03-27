-- AlterTable
ALTER TABLE "groups" ADD COLUMN "statuteUrl" VARCHAR(2000),
ADD COLUMN "localRulesNote" TEXT,
ADD COLUMN "richPublicProfile" BOOLEAN NOT NULL DEFAULT false;
