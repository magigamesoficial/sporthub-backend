-- CreateEnum
CREATE TYPE "GameKind" AS ENUM ('MATCH', 'SOCIAL');

-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'WAITLIST';

-- AlterTable
ALTER TABLE "groups" ADD COLUMN "rsvpAllowMaybe" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "groups" ADD COLUMN "rsvpDeadlineHoursBeforeStart" INTEGER;
ALTER TABLE "groups" ADD COLUMN "eventMaxParticipants" INTEGER;
ALTER TABLE "groups" ADD COLUMN "eventReservedSlots" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "group_games" ADD COLUMN "kind" "GameKind" NOT NULL DEFAULT 'MATCH';

ALTER TABLE "game_attendances" ADD COLUMN "waitlistEnteredAt" TIMESTAMP(3);
ALTER TABLE "game_attendances" ADD COLUMN "forcedByModerator" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "game_attendances_gameId_status_idx" ON "game_attendances"("gameId", "status");
