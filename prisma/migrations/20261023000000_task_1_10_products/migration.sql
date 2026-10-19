-- Task 1.10: product master. New tables products and product_code_counters (existing data is untouched), plus
-- database rules and the identity and reference-integrity triggers below. Forward-only.
-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "hsn_sac_code_id" UUID,
    "unit_id" UUID,
    "tax_category_id" UUID NOT NULL,
    "mrp" DECIMAL(18,2),
    "selling_price" DECIMAL(18,2) NOT NULL,
    "price_includes_tax" BOOLEAN NOT NULL DEFAULT false,
    "track_inventory" BOOLEAN NOT NULL DEFAULT false,
    "barcode" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_code_counters" (
    "organization_id" UUID NOT NULL,
    "last_number" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_code_counters_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE INDEX "products_organization_id_is_active_idx" ON "products"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "products_organization_id_name_idx" ON "products"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_sku_key" ON "products"("organization_id", "sku");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_hsn_sac_code_id_fkey" FOREIGN KEY ("hsn_sac_code_id") REFERENCES "hsn_sac_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tax_category_id_fkey" FOREIGN KEY ("tax_category_id") REFERENCES "tax_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_code_counters" ADD CONSTRAINT "product_code_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------
-- Task 1.10 database rules (hand-written; forward-only). The service validates first and reports friendly
-- problems; these rules make the same things true for ANY writer.

-- A barcode identifies one product per organization when present.
CREATE UNIQUE INDEX "products_organization_id_barcode_key" ON "products"("organization_id", "barcode") WHERE "barcode" IS NOT NULL;

ALTER TABLE "products"
  ADD CONSTRAINT "products_sku_format" CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  ADD CONSTRAINT "products_kind_valid" CHECK ("kind" IN ('GOODS', 'SERVICE')),
  ADD CONSTRAINT "products_name_present" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "products_selling_price_not_negative" CHECK ("selling_price" >= 0),
  ADD CONSTRAINT "products_mrp_not_negative" CHECK ("mrp" IS NULL OR "mrp" >= 0),
  -- Goods are counted in a unit of measure.
  ADD CONSTRAINT "products_goods_have_unit" CHECK ("kind" <> 'GOODS' OR "unit_id" IS NOT NULL),
  -- Services never track inventory and so can never generate stock movements.
  ADD CONSTRAINT "products_service_no_inventory" CHECK ("kind" <> 'SERVICE' OR NOT "track_inventory"),
  ADD CONSTRAINT "products_barcode_format" CHECK ("barcode" IS NULL OR "barcode" ~ '^[A-Za-z0-9._/-]{1,64}$'),
  ADD CONSTRAINT "products_version_positive" CHECK ("version" >= 1);

ALTER TABLE "product_code_counters"
  ADD CONSTRAINT "product_code_counters_not_negative" CHECK ("last_number" >= 0);

-- Products are referenced by documents and stock later: never deleted, and the identifying columns never change.
CREATE FUNCTION "protect_product_identity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'products cannot be deleted: make the product inactive instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."sku" IS DISTINCT FROM OLD."sku"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a product''s id, organization, sku, kind and creation time cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "products_protect_identity"
  BEFORE UPDATE OR DELETE ON "products"
  FOR EACH ROW EXECUTE FUNCTION "protect_product_identity"();

-- Reference integrity that a foreign key cannot express: a product may only use its OWN organization's unit and tax
-- category, and the HSN/SAC code must match the product kind (HSN for goods, SAC for services).
CREATE FUNCTION "check_product_references"() RETURNS trigger
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
    SELECT "kind" INTO ref_kind FROM "hsn_sac_codes" WHERE "id" = NEW."hsn_sac_code_id";
    IF (NEW."kind" = 'GOODS' AND ref_kind IS DISTINCT FROM 'HSN') OR (NEW."kind" = 'SERVICE' AND ref_kind IS DISTINCT FROM 'SAC') THEN
      RAISE EXCEPTION 'goods use an HSN code and services a SAC code' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "products_check_references"
  BEFORE INSERT OR UPDATE OF "unit_id", "tax_category_id", "hsn_sac_code_id", "kind" ON "products"
  FOR EACH ROW EXECUTE FUNCTION "check_product_references"();
