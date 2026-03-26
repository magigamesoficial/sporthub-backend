-- CreateEnum
CREATE TYPE "LedgerEntryKind" AS ENUM ('INCOME', 'EXPENSE');

-- CreateTable
CREATE TABLE "group_ledger_entries" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "kind" "LedgerEntryKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_ledger_entries_groupId_occurredAt_idx" ON "group_ledger_entries"("groupId", "occurredAt");

-- AddForeignKey
ALTER TABLE "group_ledger_entries" ADD CONSTRAINT "group_ledger_entries_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_ledger_entries" ADD CONSTRAINT "group_ledger_entries_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
