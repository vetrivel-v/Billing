-- Task 1.13: sales invoices (posted-only, immutable). New tables sales_invoices and sales_invoice_lines; the stock ledger vocabulary
-- gains SALES_DISPATCH; every INVOICE sequence gets a DEMO_INVOICE twin. Existing data is otherwise untouched. Forward-only.
-- CreateTable
CREATE TABLE "sales_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "post_operation_id" UUID NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "is_demo" BOOLEAN NOT NULL,
    "invoice_date" DATE NOT NULL,
    "financial_year_id" UUID NOT NULL,
    "financial_year_label" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "location_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "seller_legal_name" TEXT NOT NULL,
    "seller_trade_name" TEXT,
    "seller_gstin" VARCHAR(15) NOT NULL,
    "seller_gst_status" TEXT NOT NULL,
    "seller_state_code" VARCHAR(2) NOT NULL,
    "seller_address_line1" TEXT NOT NULL,
    "seller_address_line2" TEXT,
    "seller_city" TEXT,
    "seller_pin_code" TEXT,
    "customer_id" UUID NOT NULL,
    "customer_code" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_gst_status" TEXT NOT NULL,
    "customer_gstin" VARCHAR(15),
    "billing_address_line1" TEXT NOT NULL,
    "billing_address_line2" TEXT,
    "billing_city" TEXT,
    "billing_state_code" VARCHAR(2) NOT NULL,
    "billing_pin_code" TEXT,
    "shipping_address_line1" TEXT NOT NULL,
    "shipping_address_line2" TEXT,
    "shipping_city" TEXT,
    "shipping_state_code" VARCHAR(2) NOT NULL,
    "shipping_pin_code" TEXT,
    "recipient_class" TEXT NOT NULL,
    "pos_state_code" VARCHAR(2) NOT NULL,
    "pos_source" TEXT NOT NULL,
    "pos_confirmed_by" UUID NOT NULL,
    "pos_confirmed_at" TIMESTAMPTZ(6) NOT NULL,
    "price_basis" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "ruleset_version" TEXT NOT NULL,
    "rounding_policy_id" TEXT NOT NULL,
    "tax_input_hash" TEXT NOT NULL,
    "tax_configuration_fingerprint" TEXT NOT NULL,
    "tax_review_id" UUID,
    "tax_calculation" JSONB NOT NULL,
    "gross_subtotal" DECIMAL(18,2) NOT NULL,
    "line_discount_total" DECIMAL(18,2) NOT NULL,
    "taxable_subtotal" DECIMAL(18,2) NOT NULL,
    "cgst_total" DECIMAL(18,2) NOT NULL,
    "sgst_total" DECIMAL(18,2) NOT NULL,
    "utgst_total" DECIMAL(18,2) NOT NULL,
    "igst_total" DECIMAL(18,2) NOT NULL,
    "rounding_adjustment_total" DECIMAL(18,2) NOT NULL,
    "round_off" DECIMAL(18,2) NOT NULL,
    "grand_total" DECIMAL(18,2) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "item_kind" TEXT NOT NULL,
    "hsn_sac_code" VARCHAR(8),
    "hsn_sac_kind" VARCHAR(3),
    "unit_code" TEXT NOT NULL,
    "unit_name" TEXT NOT NULL,
    "tax_category_id" UUID NOT NULL,
    "tax_category_code" TEXT NOT NULL,
    "tax_category_name" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "tax_rate_id" UUID NOT NULL,
    "rate_percent" DECIMAL(7,4) NOT NULL,
    "rate_effective_from" DATE NOT NULL,
    "rate_effective_to" DATE,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "price_basis" TEXT NOT NULL,
    "gross_amount" DECIMAL(18,2) NOT NULL,
    "discount_type" TEXT NOT NULL,
    "discount_percent" DECIMAL(7,4),
    "discount_amount" DECIMAL(18,2) NOT NULL,
    "taxable_value" DECIMAL(18,2) NOT NULL,
    "cgst_rate" DECIMAL(8,5),
    "cgst_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgst_rate" DECIMAL(8,5),
    "sgst_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "utgst_rate" DECIMAL(8,5),
    "utgst_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igst_rate" DECIMAL(8,5),
    "igst_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rounding_adjustment" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,
    "stock_effect" TEXT NOT NULL,

    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_invoices_organization_id_invoice_date_idx" ON "sales_invoices"("organization_id", "invoice_date" DESC);

-- CreateIndex
CREATE INDEX "sales_invoices_organization_id_customer_id_idx" ON "sales_invoices"("organization_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_organization_id_post_operation_id_key" ON "sales_invoices"("organization_id", "post_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_organization_id_document_type_document_numbe_key" ON "sales_invoices"("organization_id", "document_type", "document_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_id_organization_id_key" ON "sales_invoices"("id", "organization_id");

-- CreateIndex
CREATE INDEX "sales_invoice_lines_organization_id_product_id_idx" ON "sales_invoice_lines"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoice_lines_invoice_id_line_no_key" ON "sales_invoice_lines"("invoice_id", "line_no");

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_financial_year_id_fkey" FOREIGN KEY ("financial_year_id") REFERENCES "financial_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "business_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_pos_confirmed_by_fkey" FOREIGN KEY ("pos_confirmed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_tax_review_id_fkey" FOREIGN KEY ("tax_review_id") REFERENCES "tax_configuration_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoice_id_organization_id_fkey" FOREIGN KEY ("invoice_id", "organization_id") REFERENCES "sales_invoices"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_tax_category_id_fkey" FOREIGN KEY ("tax_category_id") REFERENCES "tax_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_tax_rate_id_fkey" FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------
-- Task 1.13 database rules (hand-written; forward-only). The service validates first and reports friendly errors;
-- these rules make the same things true for ANY writer (ADR-0024).

-- 1. Inventory: SALES_DISPATCH joins the ledger vocabulary (negative quantity; only for source type SALES_INVOICE and back).
ALTER TABLE "stock_movements"
  DROP CONSTRAINT "stock_movements_type_valid",
  DROP CONSTRAINT "stock_movements_sign_matches_type";
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_type_valid" CHECK ("movement_type" IN ('OPENING_STOCK', 'STOCK_RECEIPT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE', 'SALES_DISPATCH')),
  ADD CONSTRAINT "stock_movements_sign_matches_type" CHECK (
    ("movement_type" IN ('OPENING_STOCK', 'STOCK_RECEIPT', 'ADJUSTMENT_INCREASE') AND "quantity_delta" > 0)
    OR ("movement_type" IN ('ADJUSTMENT_DECREASE', 'SALES_DISPATCH') AND "quantity_delta" < 0)),
  ADD CONSTRAINT "stock_movements_sales_dispatch_source" CHECK (("movement_type" = 'SALES_DISPATCH') = ("source_type" = 'SALES_INVOICE'));

-- 2. Numbering: every existing INVOICE sequence gets its DEMO_INVOICE twin (same organization, location and financial year), so
--    demo invoices never consume the production sequence. New organizations get it from first-run setup.
INSERT INTO "document_sequences" ("organization_id", "location_id", "financial_year_id", "document_type", "prefix", "suffix", "numeric_length", "start_number", "reset_policy", "is_active", "last_number", "updated_at")
SELECT s."organization_id", s."location_id", s."financial_year_id", 'DEMO_INVOICE', 'DEMO/{FY}/', '', s."numeric_length", 1, 'FINANCIAL_YEAR', true, 0, now()
  FROM "document_sequences" s
 WHERE s."document_type" = 'INVOICE'
   AND NOT EXISTS (
     SELECT 1 FROM "document_sequences" d
      WHERE d."organization_id" = s."organization_id" AND d."financial_year_id" = s."financial_year_id"
        AND d."document_type" = 'DEMO_INVOICE' AND d."location_id" IS NOT DISTINCT FROM s."location_id");

-- 3. Invoice header rules
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_status_valid" CHECK ("status" = 'POSTED'),
  ADD CONSTRAINT "sales_invoices_document_type_valid" CHECK ("document_type" IN ('INVOICE', 'DEMO_INVOICE')),
  -- A demo invoice always has the DEMO number series and a production invoice never does: the two can never be confused or converted.
  ADD CONSTRAINT "sales_invoices_demo_matches_type" CHECK ("is_demo" = ("document_type" = 'DEMO_INVOICE')),
  -- A production invoice records the tax review that was current when it was posted.
  ADD CONSTRAINT "sales_invoices_production_has_review" CHECK ("is_demo" OR "tax_review_id" IS NOT NULL),
  ADD CONSTRAINT "sales_invoices_number_present" CHECK (length(btrim("document_number")) > 0 AND length(btrim("financial_year_label")) > 0),
  ADD CONSTRAINT "sales_invoices_hashes_format" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$' AND "tax_input_hash" ~ '^[0-9a-f]{64}$' AND "tax_configuration_fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "sales_invoices_currency_inr" CHECK ("currency" = 'INR'),
  ADD CONSTRAINT "sales_invoices_pos_source_valid" CHECK ("pos_source" IN ('USER_CONFIRMED', 'USER_OVERRIDE')),
  ADD CONSTRAINT "sales_invoices_price_basis_valid" CHECK ("price_basis" IN ('EXCLUSIVE', 'INCLUSIVE')),
  ADD CONSTRAINT "sales_invoices_recipient_class_valid" CHECK (
    "recipient_class" IN ('B2B', 'B2C') AND (("recipient_class" = 'B2B') = ("customer_gstin" IS NOT NULL))),
  ADD CONSTRAINT "sales_invoices_state_codes_format" CHECK (
    "seller_state_code" ~ '^[0-9]{2}$' AND "billing_state_code" ~ '^[0-9]{2}$' AND "shipping_state_code" ~ '^[0-9]{2}$' AND "pos_state_code" ~ '^[0-9]{2}$'),
  ADD CONSTRAINT "sales_invoices_gstin_format" CHECK (
    "seller_gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
    AND ("customer_gstin" IS NULL OR "customer_gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')),
  ADD CONSTRAINT "sales_invoices_seller_registered" CHECK ("seller_gst_status" = 'REGISTERED'),
  ADD CONSTRAINT "sales_invoices_money_not_negative" CHECK (
    "gross_subtotal" >= 0 AND "line_discount_total" >= 0 AND "taxable_subtotal" >= 0 AND "cgst_total" >= 0 AND "sgst_total" >= 0
    AND "utgst_total" >= 0 AND "igst_total" >= 0 AND "grand_total" >= 0),
  ADD CONSTRAINT "sales_invoices_total_consistent" CHECK (
    "grand_total" = "taxable_subtotal" + "cgst_total" + "sgst_total" + "utgst_total" + "igst_total" + "rounding_adjustment_total" + "round_off");

-- 4. Invoice line rules
ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT "sales_invoice_lines_line_no_positive" CHECK ("line_no" >= 1),
  ADD CONSTRAINT "sales_invoice_lines_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "sales_invoice_lines_goods_only" CHECK ("item_kind" = 'GOODS'),
  ADD CONSTRAINT "sales_invoice_lines_stock_effect_valid" CHECK ("stock_effect" IN ('DISPATCH', 'NONE')),
  ADD CONSTRAINT "sales_invoice_lines_price_basis_valid" CHECK ("price_basis" IN ('EXCLUSIVE', 'INCLUSIVE')),
  ADD CONSTRAINT "sales_invoice_lines_classification_valid" CHECK ("classification" IN ('STANDARD', 'NIL_RATED', 'EXEMPT', 'NON_GST')),
  ADD CONSTRAINT "sales_invoice_lines_discount_valid" CHECK (
    "discount_type" IN ('NONE', 'PERCENT', 'AMOUNT')
    AND (("discount_type" = 'PERCENT') = ("discount_percent" IS NOT NULL))
    AND ("discount_percent" IS NULL OR "discount_percent" BETWEEN 0 AND 100)
    AND "discount_amount" >= 0 AND "discount_amount" <= "gross_amount"
    AND ("discount_type" <> 'NONE' OR "discount_amount" = 0)),
  ADD CONSTRAINT "sales_invoice_lines_money_not_negative" CHECK (
    "unit_price" >= 0 AND "gross_amount" >= 0 AND "taxable_value" >= 0 AND "cgst_amount" >= 0 AND "sgst_amount" >= 0
    AND "utgst_amount" >= 0 AND "igst_amount" >= 0 AND "line_total" >= 0),
  -- A component amount exists only with its rate.
  ADD CONSTRAINT "sales_invoice_lines_components_consistent" CHECK (
    ("cgst_rate" IS NOT NULL OR "cgst_amount" = 0) AND ("sgst_rate" IS NOT NULL OR "sgst_amount" = 0)
    AND ("utgst_rate" IS NOT NULL OR "utgst_amount" = 0) AND ("igst_rate" IS NOT NULL OR "igst_amount" = 0)),
  ADD CONSTRAINT "sales_invoice_lines_total_consistent" CHECK (
    "line_total" = "taxable_value" + "cgst_amount" + "sgst_amount" + "utgst_amount" + "igst_amount" + "rounding_adjustment");

-- 5. Posted invoices never change and are never deleted, for ANY writer. A correction will be a later, explicit document.
CREATE FUNCTION "sales_invoices_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'posted sales invoices are immutable: they cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "sales_invoices_no_change" BEFORE UPDATE OR DELETE ON "sales_invoices"
  FOR EACH ROW EXECUTE FUNCTION "sales_invoices_immutable"();
CREATE TRIGGER "sales_invoices_no_truncate" BEFORE TRUNCATE ON "sales_invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION "sales_invoices_immutable"();
CREATE TRIGGER "sales_invoice_lines_no_change" BEFORE UPDATE OR DELETE ON "sales_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "sales_invoices_immutable"();
CREATE TRIGGER "sales_invoice_lines_no_truncate" BEFORE TRUNCATE ON "sales_invoice_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION "sales_invoices_immutable"();

-- 6. Everything an invoice points at belongs to the invoice organization.
CREATE FUNCTION "check_sales_invoice"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_org uuid;
BEGIN
  SELECT "organization_id" INTO ref_org FROM "customers" WHERE "id" = NEW."customer_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the customer belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "business_locations" WHERE "id" = NEW."location_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the location belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "warehouses" WHERE "id" = NEW."warehouse_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the warehouse belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "financial_years" WHERE "id" = NEW."financial_year_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the financial year belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "users" WHERE "id" = NEW."created_by";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the user belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "users" WHERE "id" = NEW."pos_confirmed_by";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the confirming user belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF NEW."tax_review_id" IS NOT NULL THEN
    SELECT "organization_id" INTO ref_org FROM "tax_configuration_reviews" WHERE "id" = NEW."tax_review_id";
    IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the tax review belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_invoices_check" BEFORE INSERT ON "sales_invoices"
  FOR EACH ROW EXECUTE FUNCTION "check_sales_invoice"();

-- A line may only be added while its invoice is being created (same transaction): a posted invoice never gains a line later.
CREATE FUNCTION "check_sales_invoice_line"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv record;
  ref_org uuid;
  ref_kind text;
  rate_cat uuid;
BEGIN
  SELECT "organization_id", "is_demo", xmin AS "created_xid" INTO inv FROM "sales_invoices" WHERE "id" = NEW."invoice_id";
  IF NOT FOUND OR inv."organization_id" IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the invoice line does not belong to an invoice of this organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF inv."created_xid" IS DISTINCT FROM pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'lines cannot be added to an invoice that was posted earlier' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "organization_id", "kind" INTO ref_org, ref_kind FROM "products" WHERE "id" = NEW."product_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the product belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF ref_kind IS DISTINCT FROM 'GOODS' THEN RAISE EXCEPTION 'only goods can be invoiced' USING ERRCODE = 'check_violation'; END IF;
  SELECT "organization_id" INTO ref_org FROM "tax_categories" WHERE "id" = NEW."tax_category_id";
  IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the tax category belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  SELECT "category_id" INTO rate_cat FROM "tax_rates" WHERE "id" = NEW."tax_rate_id";
  IF rate_cat IS DISTINCT FROM NEW."tax_category_id" THEN RAISE EXCEPTION 'the tax rate does not belong to the tax category' USING ERRCODE = 'foreign_key_violation'; END IF;
  -- A demo invoice never touches stock.
  IF inv."is_demo" AND NEW."stock_effect" <> 'NONE' THEN
    RAISE EXCEPTION 'a demo invoice cannot have a stock effect' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_invoice_lines_check" BEFORE INSERT ON "sales_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "check_sales_invoice_line"();

-- 7. Commit-time integrity (deferred constraint triggers, evaluated at COMMIT).
-- 7a. The number is the one the numbering ledger issued to THIS invoice, in the invoice financial year; the header totals are
--     the sums of its lines; there is at least one line.
CREATE FUNCTION "verify_sales_invoice_at_commit"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sums record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "document_number_allocations" a JOIN "document_sequences" s ON s."id" = a."sequence_id"
     WHERE a."organization_id" = NEW."organization_id" AND a."document_type" = NEW."document_type"
       AND a."document_ref" = NEW."id"::text AND a."formatted_number" = NEW."document_number"
       AND s."financial_year_id" = NEW."financial_year_id") THEN
    RAISE EXCEPTION 'the invoice number was not issued to this invoice by the numbering ledger' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) AS "n", COALESCE(sum("gross_amount"), 0) AS "gross", COALESCE(sum("discount_amount"), 0) AS "disc",
         COALESCE(sum("taxable_value"), 0) AS "taxable", COALESCE(sum("cgst_amount"), 0) AS "cgst", COALESCE(sum("sgst_amount"), 0) AS "sgst",
         COALESCE(sum("utgst_amount"), 0) AS "utgst", COALESCE(sum("igst_amount"), 0) AS "igst",
         COALESCE(sum("rounding_adjustment"), 0) AS "adj", COALESCE(sum("line_total"), 0) AS "total"
    INTO sums FROM "sales_invoice_lines" WHERE "invoice_id" = NEW."id";
  IF sums."n" < 1
     OR sums."gross" <> NEW."gross_subtotal" OR sums."disc" <> NEW."line_discount_total" OR sums."taxable" <> NEW."taxable_subtotal"
     OR sums."cgst" <> NEW."cgst_total" OR sums."sgst" <> NEW."sgst_total" OR sums."utgst" <> NEW."utgst_total" OR sums."igst" <> NEW."igst_total"
     OR sums."adj" <> NEW."rounding_adjustment_total" OR sums."total" + NEW."round_off" <> NEW."grand_total" THEN
    RAISE EXCEPTION 'the invoice totals do not equal the sums of its lines' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "sales_invoices_verify" AFTER INSERT ON "sales_invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_sales_invoice_at_commit"();

-- 7b. Invoice line -> stock: a DISPATCH line has exactly its matching SALES_DISPATCH movement; a NONE line has none.
CREATE FUNCTION "verify_sales_invoice_line_stock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv record;
  n integer;
BEGIN
  SELECT "warehouse_id", "invoice_date" INTO inv FROM "sales_invoices" WHERE "id" = NEW."invoice_id";
  SELECT count(*) INTO n FROM "stock_movements" m
   WHERE m."organization_id" = NEW."organization_id" AND m."movement_type" = 'SALES_DISPATCH' AND m."source_type" = 'SALES_INVOICE'
     AND m."source_ref" = NEW."invoice_id"::text AND m."source_line_ref" = NEW."id"::text;
  IF NEW."stock_effect" = 'DISPATCH' THEN
    IF n <> 1 OR NOT EXISTS (
      SELECT 1 FROM "stock_movements" m
       WHERE m."organization_id" = NEW."organization_id" AND m."movement_type" = 'SALES_DISPATCH' AND m."source_type" = 'SALES_INVOICE'
         AND m."source_ref" = NEW."invoice_id"::text AND m."source_line_ref" = NEW."id"::text
         AND m."product_id" = NEW."product_id" AND m."warehouse_id" = inv."warehouse_id"
         AND m."quantity_delta" = -NEW."quantity" AND m."business_date" = inv."invoice_date") THEN
      RAISE EXCEPTION 'a DISPATCH invoice line needs exactly its matching SALES_DISPATCH stock movement' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF n <> 0 THEN
    RAISE EXCEPTION 'an invoice line without a stock effect cannot have a SALES_DISPATCH stock movement' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "sales_invoice_lines_verify_stock" AFTER INSERT ON "sales_invoice_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_sales_invoice_line_stock"();

-- 7c. Stock -> invoice line: a SALES_DISPATCH movement must belong to a DISPATCH line of a PRODUCTION invoice with the same
--     product, warehouse, exact quantity and date. No orphan stock movement is possible.
CREATE FUNCTION "verify_sales_dispatch_movement"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."source_ref" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NEW."source_line_ref" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'a SALES_DISPATCH movement must reference an invoice and an invoice line' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "sales_invoice_lines" l JOIN "sales_invoices" i ON i."id" = l."invoice_id"
     WHERE l."id" = NEW."source_line_ref"::uuid AND l."invoice_id" = NEW."source_ref"::uuid
       AND l."organization_id" = NEW."organization_id" AND l."product_id" = NEW."product_id"
       AND l."stock_effect" = 'DISPATCH' AND l."quantity" = -NEW."quantity_delta"
       AND NOT i."is_demo" AND i."warehouse_id" = NEW."warehouse_id" AND i."invoice_date" = NEW."business_date") THEN
    RAISE EXCEPTION 'a SALES_DISPATCH stock movement needs its matching DISPATCH line of a production invoice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "stock_movements_verify_dispatch" AFTER INSERT ON "stock_movements"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."movement_type" = 'SALES_DISPATCH')
  EXECUTE FUNCTION "verify_sales_dispatch_movement"();

-- 8. Reports and receivables read PRODUCTION invoices only: demo invoices are never in this view.
CREATE VIEW "production_sales_invoices" WITH (security_invoker = true) AS
  SELECT * FROM "sales_invoices" WHERE NOT "is_demo";
