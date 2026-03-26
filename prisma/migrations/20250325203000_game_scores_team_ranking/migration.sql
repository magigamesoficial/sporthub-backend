-- CreateEnum
CREATE TYPE "GameTeamSide" AS ENUM ('TEAM_A', 'TEAM_B');

-- AlterTable
ALTER TABLE "group_games" ADD COLUMN "teamAScore" INTEGER;
ALTER TABLE "group_games" ADD COLUMN "teamBScore" INTEGER;

ALTER TABLE "game_attendances" ADD COLUMN "teamSide" "GameTeamSide";
