-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('GOING', 'NOT_GOING', 'MAYBE');

-- CreateTable
CREATE TABLE "group_games" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Jogo',
    "location" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_attendances" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_games_groupId_startsAt_idx" ON "group_games"("groupId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "game_attendances_gameId_userId_key" ON "game_attendances"("gameId", "userId");

-- AddForeignKey
ALTER TABLE "group_games" ADD CONSTRAINT "group_games_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_games" ADD CONSTRAINT "group_games_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "game_attendances" ADD CONSTRAINT "game_attendances_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "group_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "game_attendances" ADD CONSTRAINT "game_attendances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
