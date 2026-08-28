-- AlterTable
ALTER TABLE "deals" ADD COLUMN "forum_topic_id" INTEGER;
ALTER TABLE "deals" ADD COLUMN "code" CHAR(6);

-- Backfill existing rows with a random 6-digit code
UPDATE "deals" SET "code" = LPAD((FLOOR(RANDOM() * 900000) + 100000)::TEXT, 6, '0') WHERE "code" IS NULL;

-- Re-roll any accidental duplicates from the backfill (practically never happens)
DO $$
DECLARE
  dup RECORD;
BEGIN
  LOOP
    SELECT id INTO dup FROM "deals" d
    WHERE EXISTS (SELECT 1 FROM "deals" d2 WHERE d2.code = d.code AND d2.id <> d.id)
    LIMIT 1;
    IF dup IS NULL THEN
      EXIT;
    END IF;
    UPDATE "deals" SET "code" = LPAD((FLOOR(RANDOM() * 900000) + 100000)::TEXT, 6, '0') WHERE id = dup.id;
  END LOOP;
END $$;

ALTER TABLE "deals" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "deals_code_key" ON "deals"("code");
