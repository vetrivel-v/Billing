-- Task 1.16: payments and receivables (append-only payments and allocations). The balance of an invoice is derived (its immutable
-- grand total minus its allocations); nothing here stores a balance. DEMO payments are separate records that can only touch DEMO
-- invoices. Every existing PAYMENT_RECEIPT sequence gains a DEMO_PAYMENT_RECEIPT twin. Existing data is otherwise untouched. Forward-only.

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "payment_number" TEXT NOT NULL,
    "is_demo" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "financial_year_id" UUID NOT NULL,
    "post_operation_id" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "is_demo" BOOLEAN NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_post_operation_id_key" ON "payments"("organization_id", "post_operation_id");
CREATE UNIQUE INDEX "payments_organization_id_document_type_payment_number_key" ON "payments"("organization_id", "document_type", "payment_number");
CREATE UNIQUE INDEX "payments_id_organization_id_key" ON "payments"("id", "organization_id");
CREATE INDEX "payments_organization_id_payment_date_idx" ON "payments"("organization_id", "payment_date" DESC);
CREATE INDEX "payments_organization_id_customer_id_idx" ON "payments"("organization_id", "customer_id");
CREATE UNIQUE INDEX "payment_allocations_payment_id_invoice_id_key" ON "payment_allocations"("payment_id", "invoice_id");
CREATE INDEX "payment_allocations_organization_id_invoice_id_idx" ON "payment_allocations"("organization_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_financial_year_id_fkey" FOREIGN KEY ("financial_year_id") REFERENCES "financial_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_organization_id_fkey" FOREIGN KEY ("payment_id", "organization_id") REFERENCES "payments"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_organization_id_fkey" FOREIGN KEY ("invoice_id", "organization_id") REFERENCES "sales_invoices"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 1. Numbering: every existing PAYMENT_RECEIPT sequence gets its DEMO_PAYMENT_RECEIPT twin, so a demo payment never consumes the
--    production receipt sequence. New organizations get it from first-run setup.
INSERT INTO "document_sequences" ("organization_id", "location_id", "financial_year_id", "document_type", "prefix", "suffix", "numeric_length", "start_number", "reset_policy", "is_active", "last_number", "updated_at")
SELECT s."organization_id", s."location_id", s."financial_year_id", 'DEMO_PAYMENT_RECEIPT', 'DPAY/{FY}/', '', s."numeric_length", 1, 'FINANCIAL_YEAR', true, 0, now()
  FROM "document_sequences" s
 WHERE s."document_type" = 'PAYMENT_RECEIPT'
   AND NOT EXISTS (
     SELECT 1 FROM "document_sequences" d
      WHERE d."organization_id" = s."organization_id" AND d."financial_year_id" = s."financial_year_id"
        AND d."document_type" = 'DEMO_PAYMENT_RECEIPT' AND d."location_id" IS NOT DISTINCT FROM s."location_id");

-- 2. Value rules
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_status_valid" CHECK ("status" = 'RECORDED'),
  ADD CONSTRAINT "payments_document_type_valid" CHECK ("document_type" IN ('PAYMENT_RECEIPT', 'DEMO_PAYMENT_RECEIPT')),
  ADD CONSTRAINT "payments_demo_matches_type" CHECK ("is_demo" = ("document_type" = 'DEMO_PAYMENT_RECEIPT')),
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "payments_method_valid" CHECK ("method" IN ('CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'CHEQUE', 'OTHER')),
  ADD CONSTRAINT "payments_reference_form" CHECK ("reference" IS NULL OR ("reference" <> '' AND char_length("reference") <= 60 AND "reference" !~ '[[:cntrl:]]')),
  ADD CONSTRAINT "payments_reference_required" CHECK ("method" NOT IN ('BANK_TRANSFER', 'UPI', 'CHEQUE') OR "reference" IS NOT NULL),
  ADD CONSTRAINT "payments_notes_form" CHECK ("notes" IS NULL OR char_length("notes") <= 500),
  ADD CONSTRAINT "payments_fingerprint_form" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_amount_positive" CHECK ("amount" > 0);

-- 3. Posted payments and allocations never change and are never deleted, for ANY writer. A correction will be a later reversal entry.
CREATE FUNCTION "payments_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recorded payments and allocations are immutable: they cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "payments_no_change" BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_immutable"();
CREATE TRIGGER "payments_no_truncate" BEFORE TRUNCATE ON "payments"
  FOR EACH STATEMENT EXECUTE FUNCTION "payments_immutable"();
CREATE TRIGGER "payment_allocations_no_change" BEFORE UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "payments_immutable"();
CREATE TRIGGER "payment_allocations_no_truncate" BEFORE TRUNCATE ON "payment_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION "payments_immutable"();

-- 4. Everything a payment points at belongs to the payment organization.
CREATE FUNCTION "check_payment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_org uuid;
BEGIN
  SELECT "organization_id" INTO ref_org FROM "customers" WHERE "id" = NEW."customer_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the customer belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "financial_years" WHERE "id" = NEW."financial_year_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the financial year belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "users" WHERE "id" = NEW."created_by";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the user belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payments_check" BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "check_payment"();

-- An allocation may only be added while its payment is being created (same transaction), only for an invoice of the SAME customer
-- and the SAME kind: a demo payment touches demo invoices only, a production payment production invoices only.
CREATE FUNCTION "check_payment_allocation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pay record;
  inv record;
BEGIN
  SELECT "organization_id", "customer_id", "is_demo", xmin AS "created_xid" INTO pay FROM "payments" WHERE "id" = NEW."payment_id";
  IF NOT FOUND OR pay."organization_id" IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the allocation does not belong to a payment of this organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF pay."created_xid" IS DISTINCT FROM pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'allocations cannot be added to a payment that was recorded earlier' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "organization_id", "customer_id", "is_demo" INTO inv FROM "sales_invoices" WHERE "id" = NEW."invoice_id";
  IF NOT FOUND OR inv."organization_id" IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the invoice belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF inv."customer_id" IS DISTINCT FROM pay."customer_id" THEN
    RAISE EXCEPTION 'a payment can only be allocated to an invoice of the same customer' USING ERRCODE = 'check_violation';
  END IF;
  IF inv."is_demo" IS DISTINCT FROM pay."is_demo" OR NEW."is_demo" IS DISTINCT FROM pay."is_demo" THEN
    RAISE EXCEPTION 'a demo payment can only be allocated to a demo invoice, and a production payment to a production invoice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_allocations_check" BEFORE INSERT ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "check_payment_allocation"();

-- 5. Commit-time rules (deferred, so a payment and its allocations can be written in any order inside the transaction).
-- 5a. The number was issued by the numbering ledger, and the payment is fully allocated: allocations sum to the amount.
CREATE FUNCTION "verify_payment_at_commit"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  total numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "document_number_allocations" a JOIN "document_sequences" s ON s."id" = a."sequence_id"
     WHERE a."organization_id" = NEW."organization_id" AND a."document_type" = NEW."document_type"
       AND a."document_ref" = NEW."id"::text AND a."formatted_number" = NEW."payment_number"
       AND s."financial_year_id" = NEW."financial_year_id") THEN
    RAISE EXCEPTION 'the payment number was not issued to this payment by the numbering ledger' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), COALESCE(sum("amount"), 0) INTO n, total FROM "payment_allocations" WHERE "payment_id" = NEW."id";
  IF n < 1 OR total <> NEW."amount" THEN
    RAISE EXCEPTION 'a payment must be fully allocated: its allocations must sum to its amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "payments_verify" AFTER INSERT ON "payments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_payment_at_commit"();

-- 5b. Over-allocation protection: the allocations of an invoice never exceed its grand total. The invoice row is locked first, so two
--     transactions allocating to the same invoice are serialized and the second one sees the first one's committed allocations.
CREATE FUNCTION "verify_invoice_allocation_at_commit"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grand numeric;
  allocated numeric;
BEGIN
  SELECT "grand_total" INTO grand FROM "sales_invoices" WHERE "id" = NEW."invoice_id" FOR NO KEY UPDATE;
  SELECT COALESCE(sum("amount"), 0) INTO allocated FROM "payment_allocations" WHERE "invoice_id" = NEW."invoice_id";
  IF allocated > grand THEN
    RAISE EXCEPTION 'the payments allocated to an invoice cannot exceed its grand total' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "payment_allocations_verify" AFTER INSERT ON "payment_allocations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_invoice_allocation_at_commit"();

-- 6. Derived balances: one row per invoice. Production reports read rows WHERE NOT is_demo.
CREATE VIEW "invoice_balances" WITH (security_invoker = true) AS
SELECT i."id" AS "invoice_id", i."organization_id", i."customer_id", i."is_demo", i."invoice_date", i."document_number", i."grand_total",
       COALESCE(a."allocated", 0) AS "allocated", i."grand_total" - COALESCE(a."allocated", 0) AS "balance_due"
  FROM "sales_invoices" i
  LEFT JOIN (SELECT "invoice_id", sum("amount") AS "allocated" FROM "payment_allocations" GROUP BY "invoice_id") a ON a."invoice_id" = i."id";
