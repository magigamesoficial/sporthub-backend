-- CreateEnum
CREATE TYPE "Sport" AS ENUM ('FOOTBALL', 'VOLLEYBALL', 'BEACH_TENNIS', 'PADEL', 'FUTVOLEI', 'BASKETBALL');

-- CreateEnum
CREATE TYPE "GroupVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "GroupMemberRole" AS ENUM ('PRESIDENT', 'VICE_PRESIDENT', 'TREASURER', 'MODERATOR', 'MEMBER');

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "publicCode" VARCHAR(6) NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "GroupVisibility" NOT NULL,
    "sport" "Sport" NOT NULL,
    "presidentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "GroupMemberRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "groups_publicCode_key" ON "groups"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_groupId_userId_key" ON "group_members"("groupId", "userId");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_presidentId_fkey" FOREIGN KEY ("presidentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "group_members" ADD CONSTRAINT "group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_members" ADD CONSTRAINT "group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
