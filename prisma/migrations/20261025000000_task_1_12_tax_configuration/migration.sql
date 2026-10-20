-- Task 1.12: tax configuration (ADR-0023). Forward-only. Contents:
--   1. customer model correction: customer_type (B2C/B2B) becomes customer_kind (INDIVIDUAL/BUSINESS), independent of GST
--      registration; a GSTIN is required for REGISTERED and COMPOSITION customers
--   2. organization-scoped, user-maintained HSN/SAC list
--   3. effective-dated tax rates cannot overlap and are immutable once written (a change is a new row)
--   4. append-only tax_configuration_reviews
-- Every pre-check below stops the whole migration with a clear message and changes NOTHING when existing data would
-- violate a new rule. No GSTIN or other identifier is ever invented, cleared or rewritten.

-- ---------------------------------------------------------------------------------------------------------
-- Pre-checks
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM "customers"
   WHERE "gst_status" IN ('REGISTERED', 'COMPOSITION') AND ("gstin" IS NULL OR btrim("gstin") = '');
  IF n > 0 THEN
    RAISE EXCEPTION 'Task 1.12 migration refused: % customer(s) are REGISTERED or COMPOSITION but have no GSTIN. Enter the real GSTIN, or set the customer to UNREGISTERED, and run the migration again. Nothing was changed.', n
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO n FROM "tax_rates" a JOIN "tax_rates" b
    ON a."category_id" = b."category_id" AND a."id" < b."id"
   AND daterange(a."effective_from", a."effective_to", '[]') && daterange(b."effective_from", b."effective_to", '[]');
  IF n > 0 THEN
    RAISE EXCEPTION 'Task 1.12 migration refused: % pair(s) of tax rates in the same category have overlapping effective dates. Close the earlier rate (set its end date) and run the migration again. Nothing was changed.', n
      USING ERRCODE = 'exclusion_violation';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 1. Customers: kind is independent of GST registration
ALTER TABLE "customers"
  DROP CONSTRAINT "customers_type_valid",
  DROP CONSTRAINT "customers_b2c_unregistered",
  DROP CONSTRAINT "customers_gstin_by_status";
ALTER TABLE "customers" RENAME COLUMN "customer_type" TO "customer_kind";
-- A label rename only: B2B (a business) -> BUSINESS, B2C (a consumer) -> INDIVIDUAL. GST facts are not touched.
UPDATE "customers" SET "customer_kind" = CASE "customer_kind" WHEN 'B2B' THEN 'BUSINESS' WHEN 'B2C' THEN 'INDIVIDUAL' END;
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_kind_valid" CHECK ("customer_kind" IN ('BUSINESS', 'INDIVIDUAL')),
  -- Registered and composition customers have a GSTIN; an unregistered customer has none.
  ADD CONSTRAINT "customers_gstin_by_status" CHECK (
    ("gst_status" = 'UNREGISTERED' AND "gstin" IS NULL)
    OR ("gst_status" IN ('REGISTERED', 'COMPOSITION') AND "gstin" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------------------------------------
-- 2. HSN/SAC: organization-scoped and user-maintained
DROP INDEX "hsn_sac_codes_code_key";
ALTER TABLE "hsn_sac_codes"
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "organization_id" UUID,
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN "review_status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "reviewed_by" UUID,
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Existing rows (none are installed by CommerceBill) get the organization of the products that use them.
UPDATE "hsn_sac_codes" h SET "organization_id" = x."org"
  FROM (SELECT "hsn_sac_code_id" AS "id", min("organization_id"::text)::uuid AS "org", count(DISTINCT "organization_id") AS "n"
          FROM "products" WHERE "hsn_sac_code_id" IS NOT NULL GROUP BY "hsn_sac_code_id") x
 WHERE h."id" = x."id" AND x."n" = 1;
DO $$
DECLARE
  orphans integer;
  orgs integer;
BEGIN
  SELECT count(*) INTO orphans FROM "hsn_sac_codes" WHERE "organization_id" IS NULL;
  SELECT count(*) INTO orgs FROM "organizations";
  IF orphans > 0 THEN
    IF orgs = 1 THEN
      UPDATE "hsn_sac_codes" SET "organization_id" = (SELECT "id" FROM "organizations") WHERE "organization_id" IS NULL;
    ELSE
      RAISE EXCEPTION 'Task 1.12 migration refused: % HSN/SAC row(s) cannot be assigned to one organization (several organizations exist and the rows are unused or shared). Assign or remove them and run the migration again. Nothing was changed.', orphans
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;
ALTER TABLE "hsn_sac_codes" ALTER COLUMN "organization_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "hsn_sac_codes_organization_id_kind_idx" ON "hsn_sac_codes"("organization_id", "kind");
CREATE UNIQUE INDEX "hsn_sac_codes_organization_id_code_key" ON "hsn_sac_codes"("organization_id", "code");
-- AddForeignKey
ALTER TABLE "hsn_sac_codes" ADD CONSTRAINT "hsn_sac_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hsn_sac_codes" ADD CONSTRAINT "hsn_sac_codes_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hsn_sac_codes"
  ADD CONSTRAINT "hsn_sac_code_format" CHECK ("code" ~ '^[0-9]{2,8}$'),
  ADD CONSTRAINT "hsn_sac_origin_valid" CHECK ("origin" IN ('USER', 'IMPORT')),
  ADD CONSTRAINT "hsn_sac_review_status_valid" CHECK ("review_status" IN ('UNREVIEWED', 'REVIEWED')),
  ADD CONSTRAINT "hsn_sac_review_consistent" CHECK (
    ("review_status" = 'REVIEWED' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    OR ("review_status" = 'UNREVIEWED' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
  ),
  ADD CONSTRAINT "hsn_sac_description_length" CHECK ("description" IS NULL OR length("description") <= 300),
  ADD CONSTRAINT "hsn_sac_version_positive" CHECK ("version" >= 1);

-- Never deleted (products and, later, posted invoices point at them); code, kind and organization never change.
-- Editing the description or the active flag drops a review mark: the entry has to be confirmed again.
CREATE FUNCTION "protect_hsn_sac_code"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HSN/SAC entries cannot be deleted: make the entry inactive instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'an HSN/SAC entry''s code, kind, organization and origin cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."description" IS DISTINCT FROM OLD."description" OR NEW."is_active" IS DISTINCT FROM OLD."is_active")
     AND NEW."review_status" = OLD."review_status" THEN
    NEW."review_status" := 'UNREVIEWED';
    NEW."reviewed_by" := NULL;
    NEW."reviewed_at" := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "hsn_sac_codes_protect" BEFORE UPDATE OR DELETE ON "hsn_sac_codes"
  FOR EACH ROW EXECUTE FUNCTION "protect_hsn_sac_code"();

-- A reviewer must belong to the entry's organization.
CREATE FUNCTION "check_hsn_sac_reviewer"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reviewer_org uuid;
BEGIN
  IF NEW."reviewed_by" IS NOT NULL THEN
    SELECT "organization_id" INTO reviewer_org FROM "users" WHERE "id" = NEW."reviewed_by";
    IF reviewer_org IS DISTINCT FROM NEW."organization_id" THEN
      RAISE EXCEPTION 'the reviewer belongs to another organization' USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "hsn_sac_codes_check_reviewer" BEFORE INSERT OR UPDATE OF "reviewed_by" ON "hsn_sac_codes"
  FOR EACH ROW EXECUTE FUNCTION "check_hsn_sac_reviewer"();

-- A product may only use an HSN/SAC entry of its OWN organization (replaces the Task 1.10 function; adds the organization check).
CREATE OR REPLACE FUNCTION "check_product_references"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_org uuid;
  ref_kind text;
BEGIN
  IF NEW."unit_id" IS NOT NULL THEN
    SELECT "organization_id" INTO ref_org FROM "units" WHERE "id" = NEW."unit_id";
    IF ref_org IS DISTINCT FROM NEW."organization_id" THEN
      RAISE EXCEPTION 'the unit of measure belongs to another organization' USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  SELECT "organization_id" INTO ref_org FROM "tax_categories" WHERE "id" = NEW."tax_category_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the tax category belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."hsn_sac_code_id" IS NOT NULL THEN
    SELECT "kind", "organization_id" INTO ref_kind, ref_org FROM "hsn_sac_codes" WHERE "id" = NEW."hsn_sac_code_id";
    IF ref_org IS DISTINCT FROM NEW."organization_id" THEN
      RAISE EXCEPTION 'the HSN/SAC entry belongs to another organization' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF (NEW."kind" = 'GOODS' AND ref_kind IS DISTINCT FROM 'HSN') OR (NEW."kind" = 'SERVICE' AND ref_kind IS DISTINCT FROM 'SAC') THEN
      RAISE EXCEPTION 'goods use an HSN code and services a SAC code' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Tax rates: no overlapping windows, immutable once written
CREATE FUNCTION "check_tax_rate_window"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cat_org uuid;
BEGIN
  -- An end date before the start date is for the CHECK constraint to report.
  IF NEW."effective_to" IS NOT NULL AND NEW."effective_to" < NEW."effective_from" THEN
    RETURN NEW;
  END IF;
  -- Serializes concurrent writers of the same category so two simultaneous inserts cannot both pass the overlap check.
  PERFORM pg_advisory_xact_lock(hashtextextended('tax_rate:' || NEW."category_id"::text, 0));
  -- A row with the same (category, start date) already exists: the unique index decides (it rejects a plain insert and lets
  -- the idempotent reference seed's ON CONFLICT DO NOTHING skip it), so no overlap verdict is needed here.
  IF EXISTS (SELECT 1 FROM "tax_rates" WHERE "category_id" = NEW."category_id" AND "effective_from" = NEW."effective_from" AND "id" <> NEW."id") THEN
    RETURN NEW;
  END IF;
  SELECT "organization_id" INTO cat_org FROM "tax_categories" WHERE "id" = NEW."category_id";
  IF cat_org IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the tax category belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "tax_rates" r
     WHERE r."category_id" = NEW."category_id" AND r."id" <> NEW."id"
       AND daterange(r."effective_from", r."effective_to", '[]') && daterange(NEW."effective_from", NEW."effective_to", '[]')
  ) THEN
    RAISE EXCEPTION 'the effective dates overlap another rate of the same tax category: close the earlier rate first' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "tax_rates_check_window" BEFORE INSERT OR UPDATE OF "category_id", "effective_from", "effective_to" ON "tax_rates"
  FOR EACH ROW EXECUTE FUNCTION "check_tax_rate_window"();

-- A rate never changes and is never deleted. The only permitted edit is CLOSING an open rate (setting its end date once);
-- review marks may change. A rate change is a new row with a new start date.
CREATE FUNCTION "protect_tax_rate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax rates cannot be deleted: add a new effective-dated rate instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."category_id" IS DISTINCT FROM OLD."category_id"
     OR NEW."rate_percent" IS DISTINCT FROM OLD."rate_percent"
     OR NEW."cess_percent" IS DISTINCT FROM OLD."cess_percent"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a tax rate cannot be changed: add a new effective-dated rate instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."effective_to" IS DISTINCT FROM OLD."effective_to" AND OLD."effective_to" IS NOT NULL THEN
    RAISE EXCEPTION 'a closed tax rate cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "tax_rates_protect" BEFORE UPDATE OR DELETE ON "tax_rates"
  FOR EACH ROW EXECUTE FUNCTION "protect_tax_rate"();

-- A tax category keeps its code, classification and organization and is never deleted. Changing anything that decides a tax
-- result drops its review mark (the review itself is the append-only table below; this is the per-row display mark).
CREATE FUNCTION "protect_tax_category"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax categories cannot be deleted: make the category inactive instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."classification" IS DISTINCT FROM OLD."classification"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a tax category''s code, classification, organization and origin cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."name" IS DISTINCT FROM OLD."name" OR NEW."is_active" IS DISTINCT FROM OLD."is_active"
      OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from" OR NEW."effective_to" IS DISTINCT FROM OLD."effective_to")
     AND NEW."review_status" = OLD."review_status" THEN
    NEW."review_status" := 'UNREVIEWED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "tax_categories_protect" BEFORE UPDATE OR DELETE ON "tax_categories"
  FOR EACH ROW EXECUTE FUNCTION "protect_tax_category"();

-- ---------------------------------------------------------------------------------------------------------
-- 4. Append-only tax configuration reviews
CREATE TABLE "tax_configuration_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reviewed_by" UUID NOT NULL,
    "reviewer_capacity" TEXT NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notice_version" TEXT NOT NULL,
    "notice_text" TEXT NOT NULL,
    "note" TEXT,
    "engine_version" TEXT NOT NULL,
    "ruleset_version" TEXT NOT NULL,
    "jurisdiction_ruleset_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_configuration_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tax_configuration_reviews_organization_id_created_at_idx" ON "tax_configuration_reviews"("organization_id", "created_at" DESC);
ALTER TABLE "tax_configuration_reviews" ADD CONSTRAINT "tax_configuration_reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tax_configuration_reviews" ADD CONSTRAINT "tax_configuration_reviews_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tax_configuration_reviews"
  ADD CONSTRAINT "tax_review_fingerprint_format" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tax_review_capacity_length" CHECK (length(btrim("reviewer_capacity")) BETWEEN 2 AND 120),
  ADD CONSTRAINT "tax_review_notice_present" CHECK (length(btrim("notice_version")) > 0 AND length(btrim("notice_text")) > 0),
  ADD CONSTRAINT "tax_review_note_length" CHECK ("note" IS NULL OR length("note") <= 1000),
  ADD CONSTRAINT "tax_review_versions_present" CHECK (
    length(btrim("engine_version")) > 0 AND length(btrim("ruleset_version")) > 0 AND length(btrim("jurisdiction_ruleset_version")) > 0
  );

CREATE FUNCTION "tax_reviews_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tax configuration reviews are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "tax_reviews_no_change" BEFORE UPDATE OR DELETE ON "tax_configuration_reviews"
  FOR EACH ROW EXECUTE FUNCTION "tax_reviews_append_only"();
CREATE TRIGGER "tax_reviews_no_truncate" BEFORE TRUNCATE ON "tax_configuration_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION "tax_reviews_append_only"();

-- The reviewer must belong to the organization being reviewed.
CREATE FUNCTION "check_tax_review_reviewer"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reviewer_org uuid;
BEGIN
  SELECT "organization_id" INTO reviewer_org FROM "users" WHERE "id" = NEW."reviewed_by";
  IF reviewer_org IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the reviewer belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "tax_reviews_check_reviewer" BEFORE INSERT ON "tax_configuration_reviews"
  FOR EACH ROW EXECUTE FUNCTION "check_tax_review_reviewer"();
