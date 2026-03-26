-- AlterTable
ALTER TABLE "scout_metric_definitions" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "scout_metric_definitions_sport_isActive_idx" ON "scout_metric_definitions"("sport", "isActive");
