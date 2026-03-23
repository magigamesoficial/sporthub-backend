-- CreateTable
CREATE TABLE "member_monthly_fees" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodMonth" VARCHAR(7) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,

    CONSTRAINT "member_monthly_fees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_monthly_fees_groupId_userId_periodMonth_key" ON "member_monthly_fees"("groupId", "userId", "periodMonth");

-- CreateIndex
CREATE INDEX "member_monthly_fees_groupId_periodMonth_idx" ON "member_monthly_fees"("groupId", "periodMonth");

-- AddForeignKey
ALTER TABLE "member_monthly_fees" ADD CONSTRAINT "member_monthly_fees_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_monthly_fees" ADD CONSTRAINT "member_monthly_fees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_monthly_fees" ADD CONSTRAINT "member_monthly_fees_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
