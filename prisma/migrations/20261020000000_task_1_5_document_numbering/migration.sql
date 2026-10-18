-- Task 1.5: document numbering engine - reset policy, active flag, the allocation ledger, and the database
-- invariants that make allocation safe regardless of application code. Forward-only.
--
-- Existing document_sequences rows (none are created by the application before Task 1.5) keep working: they
-- receive reset_policy FINANCIAL_YEAR and is_active true. If an existing row violates a new CHECK the migration
-- ABORTS atomically rather than guessing.

-- AlterTable
ALTER TABLE "document_sequences" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reset_policy" TEXT NOT NULL DEFAULT 'FINANCIAL_YEAR';

-- CreateTable
CREATE TABLE "document_number_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "sequence_number" BIGINT NOT NULL,
    "formatted_number" TEXT NOT NULL,
    "document_ref" TEXT NOT NULL,
    "allocated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,

    CONSTRAINT "document_number_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_number_allocations_organization_id_allocated_at_idx" ON "document_number_allocations"("organization_id", "allocated_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_number_allocations_sequence_id_sequence_number_key" ON "document_number_allocations"("sequence_id", "sequence_number");

-- CreateIndex
CREATE UNIQUE INDEX "document_number_allocations_organization_id_document_type_f_key" ON "document_number_allocations"("organization_id", "document_type", "formatted_number");

-- CreateIndex
CREATE UNIQUE INDEX "document_number_allocations_organization_id_document_type_d_key" ON "document_number_allocations"("organization_id", "document_type", "document_ref");

-- AddForeignKey
ALTER TABLE "document_number_allocations" ADD CONSTRAINT "document_number_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_number_allocations" ADD CONSTRAINT "document_number_allocations_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "document_sequences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written additions (not expressible in schema.prisma)
-- ===========================================================================

-- Configuration sanity (format only; the service validates the allowed characters and the {FY} rules).
ALTER TABLE "document_sequences"
  ADD CONSTRAINT "document_sequences_type_form_chk" CHECK ("document_type" ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  ADD CONSTRAINT "document_sequences_reset_chk" CHECK ("reset_policy" IN ('FINANCIAL_YEAR', 'NEVER')),
  ADD CONSTRAINT "document_sequences_affix_len_chk" CHECK (char_length("prefix") <= 40 AND char_length("suffix") <= 40),
  ADD CONSTRAINT "document_sequences_start_fits_chk" CHECK (char_length("start_number"::text) <= "numeric_length");

-- The counter may only move forward by exactly one (first number = start number), identity never changes,
-- and the start number is frozen once a number has been issued. Direct SQL cannot skip, repeat or rewind.
CREATE FUNCTION "document_sequences_guard_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
     OR NEW."financial_year_id" IS DISTINCT FROM OLD."financial_year_id"
     OR NEW."document_type" IS DISTINCT FROM OLD."document_type" THEN
    RAISE EXCEPTION 'a sequence''s organization, location, financial year and document type are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."last_number" > 0 AND NEW."start_number" IS DISTINCT FROM OLD."start_number" THEN
    RAISE EXCEPTION 'the start number cannot change after numbers have been issued'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."last_number" IS DISTINCT FROM OLD."last_number" THEN
    IF NOT ((OLD."last_number" = 0 AND NEW."last_number" = NEW."start_number")
         OR (OLD."last_number" > 0 AND NEW."last_number" = OLD."last_number" + 1)) THEN
      RAISE EXCEPTION 'sequence numbers must advance by exactly one (the first number is the start number)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "document_sequences_guard_update"
  BEFORE UPDATE ON "document_sequences"
  FOR EACH ROW EXECUTE FUNCTION "document_sequences_guard_update"();

-- Sequences are never deleted: their history must stay queryable. Deactivate instead.
CREATE FUNCTION "document_sequences_block_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document sequences cannot be deleted: deactivate the sequence instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "document_sequences_no_delete"
  BEFORE DELETE ON "document_sequences"
  FOR EACH ROW EXECUTE FUNCTION "document_sequences_block_delete"();

-- Ledger rows: sane values, internally consistent with the sequence, and append-only.
ALTER TABLE "document_number_allocations"
  ADD CONSTRAINT "document_number_allocations_number_chk" CHECK ("sequence_number" > 0),
  ADD CONSTRAINT "document_number_allocations_text_chk"
    CHECK (char_length("formatted_number") BETWEEN 1 AND 100 AND char_length("document_ref") BETWEEN 1 AND 200),
  ADD CONSTRAINT "document_number_allocations_type_form_chk" CHECK ("document_type" ~ '^[A-Z][A-Z0-9_]{0,49}$');

-- A ledger entry must describe a number the sequence has really reached, for the same organization and type.
-- (The allocation advances the counter first, in the same transaction, then records it here.)
CREATE FUNCTION "document_number_allocations_check_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seq RECORD;
BEGIN
  SELECT "organization_id", "document_type", "last_number" INTO seq
    FROM "document_sequences" WHERE "id" = NEW."sequence_id";
  IF seq IS NULL
     OR seq."organization_id" <> NEW."organization_id"
     OR seq."document_type" <> NEW."document_type"
     OR NEW."sequence_number" > seq."last_number" THEN
    RAISE EXCEPTION 'allocation ledger entry does not match its sequence'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "document_number_allocations_check_insert"
  BEFORE INSERT ON "document_number_allocations"
  FOR EACH ROW EXECUTE FUNCTION "document_number_allocations_check_insert"();

CREATE FUNCTION "document_number_allocations_block_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_number_allocations is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "document_number_allocations_no_update_delete"
  BEFORE UPDATE OR DELETE ON "document_number_allocations"
  FOR EACH ROW EXECUTE FUNCTION "document_number_allocations_block_mutation"();
CREATE TRIGGER "document_number_allocations_no_truncate"
  BEFORE TRUNCATE ON "document_number_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION "document_number_allocations_block_mutation"();
