-- CreateEnum
CREATE TYPE "GameOutcome" AS ENUM ('WIN', 'DRAW', 'LOSS');

-- CreateTable
CREATE TABLE "group_fee_plans" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_fee_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "group_fee_plans_groupId_idx" ON "group_fee_plans"("groupId");

ALTER TABLE "group_fee_plans" ADD CONSTRAINT "group_fee_plans_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_members" ADD COLUMN "feePlanId" TEXT;

ALTER TABLE "group_members" ADD CONSTRAINT "group_members_feePlanId_fkey"
  FOREIGN KEY ("feePlanId") REFERENCES "group_fee_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "member_monthly_fees" ADD COLUMN "feePlanId" TEXT;

ALTER TABLE "member_monthly_fees" ADD CONSTRAINT "member_monthly_fees_feePlanId_fkey"
  FOREIGN KEY ("feePlanId") REFERENCES "group_fee_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "group_games" ADD COLUMN "outcome" "GameOutcome";

ALTER TABLE "group_ledger_entries" ADD COLUMN "memberMonthlyFeeId" TEXT;

CREATE UNIQUE INDEX "group_ledger_entries_memberMonthlyFeeId_key" ON "group_ledger_entries"("memberMonthlyFeeId");

ALTER TABLE "group_ledger_entries" ADD CONSTRAINT "group_ledger_entries_memberMonthlyFeeId_fkey"
  FOREIGN KEY ("memberMonthlyFeeId") REFERENCES "member_monthly_fees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "scout_metric_definitions" (
    "id" TEXT NOT NULL,
    "sport" "Sport" NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scout_metric_definitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scout_metric_definitions_sport_idx" ON "scout_metric_definitions"("sport");

CREATE UNIQUE INDEX "scout_metric_definitions_sport_key_key" ON "scout_metric_definitions"("sport", "key");

CREATE TABLE "group_enabled_scouts" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "scoutMetricDefinitionId" TEXT NOT NULL,

    CONSTRAINT "group_enabled_scouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "group_enabled_scouts_groupId_scoutMetricDefinitionId_key"
  ON "group_enabled_scouts"("groupId", "scoutMetricDefinitionId");

ALTER TABLE "group_enabled_scouts" ADD CONSTRAINT "group_enabled_scouts_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_enabled_scouts" ADD CONSTRAINT "group_enabled_scouts_scoutMetricDefinitionId_fkey"
  FOREIGN KEY ("scoutMetricDefinitionId") REFERENCES "scout_metric_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "game_scout_stats" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scoutMetricDefinitionId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "game_scout_stats_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "game_scout_stats_gameId_idx" ON "game_scout_stats"("gameId");

CREATE UNIQUE INDEX "game_scout_stats_gameId_userId_scoutMetricDefinitionId_key"
  ON "game_scout_stats"("gameId", "userId", "scoutMetricDefinitionId");

ALTER TABLE "game_scout_stats" ADD CONSTRAINT "game_scout_stats_gameId_fkey"
  FOREIGN KEY ("gameId") REFERENCES "group_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "game_scout_stats" ADD CONSTRAINT "game_scout_stats_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "game_scout_stats" ADD CONSTRAINT "game_scout_stats_scoutMetricDefinitionId_fkey"
  FOREIGN KEY ("scoutMetricDefinitionId") REFERENCES "scout_metric_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
