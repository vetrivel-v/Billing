-- Task 1.9: customer master. New tables customers and customer_code_counters (existing data is untouched), plus
-- database rules and the identity-protection trigger below. Forward-only.
-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "customer_type" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT,
    "contact_person" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "alternate_phone" TEXT,
    "gst_status" "GstRegistrationStatus" NOT NULL DEFAULT 'UNREGISTERED',
    "gstin" VARCHAR(15),
    "pan" VARCHAR(10),
    "billing_address_line1" TEXT NOT NULL,
    "billing_address_line2" TEXT,
    "billing_city" TEXT,
    "billing_state_code" VARCHAR(2) NOT NULL,
    "billing_pin_code" VARCHAR(6),
    "country" VARCHAR(2) NOT NULL DEFAULT 'IN',
    "shipping_same_as_billing" BOOLEAN NOT NULL DEFAULT true,
    "shipping_address_line1" TEXT,
    "shipping_address_line2" TEXT,
    "shipping_city" TEXT,
    "shipping_state_code" VARCHAR(2),
    "shipping_pin_code" VARCHAR(6),
    "place_of_supply_state_code" VARCHAR(2) NOT NULL,
    "credit_limit" DECIMAL(14,2),
    "payment_terms_days" INTEGER,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_code_counters" (
    "organization_id" UUID NOT NULL,
    "last_number" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_code_counters_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE INDEX "customers_organization_id_is_active_idx" ON "customers"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "customers_organization_id_legal_name_idx" ON "customers"("organization_id", "legal_name");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_code_key" ON "customers"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_code_counters" ADD CONSTRAINT "customer_code_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------
-- Task 1.9 database rules (hand-written; forward-only). The service validates first and reports friendly
-- problems; these constraints make the same rules true for ANY writer.

-- One GSTIN identifies one customer record per organization (inactive records still count).
CREATE UNIQUE INDEX "customers_organization_id_gstin_key" ON "customers"("organization_id", "gstin") WHERE "gstin" IS NOT NULL;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_code_format" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$'),
  ADD CONSTRAINT "customers_type_valid" CHECK ("customer_type" IN ('B2C', 'B2B')),
  ADD CONSTRAINT "customers_legal_name_present" CHECK (length(btrim("legal_name")) > 0),
  -- A consumer (B2C) customer has no GST registration.
  ADD CONSTRAINT "customers_b2c_unregistered" CHECK ("customer_type" <> 'B2C' OR "gst_status" = 'UNREGISTERED'),
  -- Registered needs a GSTIN, unregistered must not have one, composition may.
  ADD CONSTRAINT "customers_gstin_by_status" CHECK (
    ("gst_status" = 'UNREGISTERED' AND "gstin" IS NULL)
    OR ("gst_status" = 'REGISTERED' AND "gstin" IS NOT NULL)
    OR "gst_status" = 'COMPOSITION'
  ),
  ADD CONSTRAINT "customers_gstin_format" CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD CONSTRAINT "customers_pan_format" CHECK ("pan" IS NULL OR "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  ADD CONSTRAINT "customers_state_codes_format" CHECK (
    "billing_state_code" ~ '^[0-9]{2}$'
    AND "place_of_supply_state_code" ~ '^[0-9]{2}$'
    AND ("shipping_state_code" IS NULL OR "shipping_state_code" ~ '^[0-9]{2}$')
  ),
  ADD CONSTRAINT "customers_pin_codes_format" CHECK (
    ("billing_pin_code" IS NULL OR "billing_pin_code" ~ '^[1-9][0-9]{5}$')
    AND ("shipping_pin_code" IS NULL OR "shipping_pin_code" ~ '^[1-9][0-9]{5}$')
  ),
  ADD CONSTRAINT "customers_country_format" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "customers_credit_limit_not_negative" CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0),
  ADD CONSTRAINT "customers_payment_terms_range" CHECK ("payment_terms_days" IS NULL OR ("payment_terms_days" BETWEEN 0 AND 365)),
  -- Shipping columns exist only when delivery differs from billing; then address line and state are required.
  ADD CONSTRAINT "customers_shipping_consistency" CHECK (
    ("shipping_same_as_billing" AND "shipping_address_line1" IS NULL AND "shipping_address_line2" IS NULL
       AND "shipping_city" IS NULL AND "shipping_state_code" IS NULL AND "shipping_pin_code" IS NULL)
    OR (NOT "shipping_same_as_billing" AND "shipping_address_line1" IS NOT NULL AND "shipping_state_code" IS NOT NULL)
  ),
  ADD CONSTRAINT "customers_version_positive" CHECK ("version" >= 1);

ALTER TABLE "customer_code_counters"
  ADD CONSTRAINT "customer_code_counters_not_negative" CHECK ("last_number" >= 0);

-- Customers are referenced by documents later: never deleted, and the identifying columns never change.
CREATE FUNCTION "protect_customer_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customers cannot be deleted: make the customer inactive instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a customer''s id, organization, code and creation time cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "customers_protect_identity"
  BEFORE UPDATE OR DELETE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "protect_customer_identity"();
