-- Task 1.1: mark reference-seeded tax data and require explicit accountant review (spec section 4),
-- and add effective dating to tax categories. Forward-only; existing rows receive the safe defaults
-- (origin USER, review_status UNREVIEWED, no effective dates).

-- AlterTable
ALTER TABLE "tax_categories" ADD COLUMN     "effective_from" DATE,
ADD COLUMN     "effective_to" DATE,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'USER',
ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "review_status" TEXT NOT NULL DEFAULT 'UNREVIEWED';

-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'USER',
ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "review_status" TEXT NOT NULL DEFAULT 'UNREVIEWED';

-- ===========================================================================
-- Hand-written additions (not expressible in schema.prisma)
-- ===========================================================================
ALTER TABLE "tax_categories"
  ADD CONSTRAINT "tax_categories_origin_chk" CHECK ("origin" IN ('USER', 'REFERENCE_SEED')),
  ADD CONSTRAINT "tax_categories_review_chk" CHECK ("review_status" IN ('UNREVIEWED', 'REVIEWED')),
  ADD CONSTRAINT "tax_categories_effective_chk"
    CHECK ("effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_origin_chk" CHECK ("origin" IN ('USER', 'REFERENCE_SEED')),
  ADD CONSTRAINT "tax_rates_review_chk" CHECK ("review_status" IN ('UNREVIEWED', 'REVIEWED'));
