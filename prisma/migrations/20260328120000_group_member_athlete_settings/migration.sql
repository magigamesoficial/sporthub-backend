-- CreateEnum
CREATE TYPE "DominantSide" AS ENUM ('LEFT', 'RIGHT', 'BOTH');

-- AlterTable
ALTER TABLE "group_members" ADD COLUMN "nickname" VARCHAR(80);
ALTER TABLE "group_members" ADD COLUMN "dominantFoot" "DominantSide";
ALTER TABLE "group_members" ADD COLUMN "dominantHand" "DominantSide";
ALTER TABLE "group_members" ADD COLUMN "shirtSize" VARCHAR(20);
ALTER TABLE "group_members" ADD COLUMN "shortsSize" VARCHAR(20);
ALTER TABLE "group_members" ADD COLUMN "shoeSize" VARCHAR(20);
ALTER TABLE "group_members" ADD COLUMN "positionKey" VARCHAR(40);
