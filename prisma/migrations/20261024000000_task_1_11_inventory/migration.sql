-- Task 1.11: inventory. New tables stock_movements (append-only ledger) and stock_balances (ledger projection); existing
-- data is untouched. Hand-written rules follow the generated tables. Forward-only.
-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "movement_type" TEXT NOT NULL,
    "quantity_delta" DECIMAL(18,4) NOT NULL,
    "business_date" DATE NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "source_line_ref" TEXT NOT NULL DEFAULT '',
    "reason_code" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity_on_hand" DECIMAL(18,4) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("warehouse_id","product_id")
);

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_product_id_created_at_idx" ON "stock_movements"("organization_id", "product_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_warehouse_id_product_id_idx" ON "stock_movements"("organization_id", "warehouse_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_created_at_idx" ON "stock_movements"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_organization_id_source_type_source_ref_sour_key" ON "stock_movements"("organization_id", "source_type", "source_ref", "source_line_ref");

-- CreateIndex
CREATE INDEX "stock_balances_organization_id_product_id_idx" ON "stock_balances"("organization_id", "product_id");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------
-- Task 1.11 database rules (hand-written; forward-only). The service validates first and reports friendly
-- problems; these rules make the same things true for ANY writer (ADR-0022).

ALTER TABLE "stock_movements"
  -- The list is widened by a later migration when sales dispatch, returns, transfers etc. arrive.
  ADD CONSTRAINT "stock_movements_type_valid" CHECK ("movement_type" IN ('OPENING_STOCK', 'STOCK_RECEIPT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE')),
  ADD CONSTRAINT "stock_movements_delta_not_zero" CHECK ("quantity_delta" <> 0),
  -- Increases are positive, the decrease type is negative: the direction is implied by the type, never ambiguous.
  ADD CONSTRAINT "stock_movements_sign_matches_type" CHECK (
    ("movement_type" IN ('OPENING_STOCK', 'STOCK_RECEIPT', 'ADJUSTMENT_INCREASE') AND "quantity_delta" > 0)
    OR ("movement_type" = 'ADJUSTMENT_DECREASE' AND "quantity_delta" < 0)),
  ADD CONSTRAINT "stock_movements_source_type_format" CHECK ("source_type" ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  ADD CONSTRAINT "stock_movements_source_ref_length" CHECK (length("source_ref") BETWEEN 1 AND 100),
  ADD CONSTRAINT "stock_movements_source_line_ref_length" CHECK (length("source_line_ref") <= 100),
  ADD CONSTRAINT "stock_movements_reason_valid" CHECK (
    ("movement_type" IN ('ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE') AND COALESCE("reason_code" IN ('COUNT_CORRECTION', 'FOUND', 'DAMAGE', 'LOSS', 'OTHER'), false))
    OR ("movement_type" NOT IN ('ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE') AND "reason_code" IS NULL)),
  ADD CONSTRAINT "stock_movements_reference_length" CHECK ("reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 60),
  ADD CONSTRAINT "stock_movements_note_length" CHECK ("note" IS NULL OR length(btrim("note")) BETWEEN 1 AND 500);

-- The no-negative-stock policy: stock on hand can never go below zero. It is enforced HERE, on the one row every
-- movement of a (warehouse, product) must update, so concurrent decreases cannot both succeed (the second waits for the
-- first row lock and then fails this check). A later organization setting may relax it by a migration.
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_not_negative" CHECK ("quantity_on_hand" >= 0);

-- Ledger rule checks. The advisory lock serializes every movement of one (warehouse, product), so the "opening stock
-- only once" rule below cannot be raced; it is released automatically at commit or rollback.
CREATE FUNCTION "check_stock_movement"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prod record;
  wh_org uuid;
  places integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || NEW."warehouse_id"::text || ':' || NEW."product_id"::text, 0));

  SELECT "organization_id", "kind", "track_inventory", "unit_id" INTO prod FROM "products" WHERE "id" = NEW."product_id";
  IF NOT FOUND OR prod."organization_id" IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the product belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF prod."kind" <> 'GOODS' OR NOT prod."track_inventory" THEN
    RAISE EXCEPTION 'only goods that track inventory can have stock movements' USING ERRCODE = 'check_violation';
  END IF;

  SELECT "organization_id" INTO wh_org FROM "warehouses" WHERE "id" = NEW."warehouse_id";
  IF wh_org IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'the warehouse belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT "decimal_places" INTO places FROM "units" WHERE "id" = prod."unit_id";
  IF places IS NULL OR NEW."quantity_delta" <> round(NEW."quantity_delta", places) THEN
    RAISE EXCEPTION 'the quantity has more decimal places than the unit allows' USING ERRCODE = 'check_violation';
  END IF;

  -- Opening stock is the first physical record of a product in a warehouse; afterwards use adjustments.
  IF NEW."movement_type" = 'OPENING_STOCK' AND EXISTS (
    SELECT 1 FROM "stock_movements" WHERE "warehouse_id" = NEW."warehouse_id" AND "product_id" = NEW."product_id") THEN
    RAISE EXCEPTION 'opening stock can only be recorded before any other stock movement' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "stock_movements_check"
  BEFORE INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "check_stock_movement"();

-- The ledger is append-only: no UPDATE, DELETE or TRUNCATE for anybody. A correction is a new opposite movement.
CREATE FUNCTION "stock_movements_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock ledger tables are append-only: post a compensating movement instead' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "stock_movements_no_change"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_append_only"();
CREATE TRIGGER "stock_movements_no_truncate"
  BEFORE TRUNCATE ON "stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION "stock_movements_append_only"();

-- The balance projection follows every movement in the same statement (so also in the same transaction). The upsert
-- takes the row lock that serializes concurrent movements of the same stock.
CREATE FUNCTION "apply_stock_movement"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- UPDATE first: an upsert would test the CHECK against the proposed delta alone (a decrease is negative). The advisory
  -- lock taken by check_stock_movement already serializes every movement of this stock, and the UPDATE locks the row.
  UPDATE "stock_balances"
     SET "quantity_on_hand" = "quantity_on_hand" + NEW."quantity_delta", "updated_at" = now()
   WHERE "warehouse_id" = NEW."warehouse_id" AND "product_id" = NEW."product_id";
  IF NOT FOUND THEN
    INSERT INTO "stock_balances" ("organization_id", "warehouse_id", "product_id", "quantity_on_hand", "updated_at")
    VALUES (NEW."organization_id", NEW."warehouse_id", NEW."product_id", NEW."quantity_delta", now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "stock_movements_apply"
  AFTER INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "apply_stock_movement"();

-- Nobody edits a balance by hand: the only permitted writer is the ledger trigger above (trigger nesting depth 2).
CREATE FUNCTION "protect_stock_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'stock_balances is maintained by the stock ledger and cannot be changed directly' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "stock_balances_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_balances"
  FOR EACH ROW EXECUTE FUNCTION "protect_stock_balance"();
CREATE TRIGGER "stock_balances_no_truncate"
  BEFORE TRUNCATE ON "stock_balances"
  FOR EACH STATEMENT EXECUTE FUNCTION "stock_movements_append_only"();

-- A product with stock history keeps its unit and keeps tracking inventory: otherwise quantities already recorded
-- would change meaning or silently disappear from view.
CREATE FUNCTION "protect_product_stock_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."unit_id" IS DISTINCT FROM OLD."unit_id" OR (OLD."track_inventory" AND NOT NEW."track_inventory"))
     AND EXISTS (SELECT 1 FROM "stock_movements" WHERE "product_id" = NEW."id") THEN
    RAISE EXCEPTION 'a product with stock movements keeps its unit and inventory tracking' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "products_protect_stock_history"
  BEFORE UPDATE OF "unit_id", "track_inventory" ON "products"
  FOR EACH ROW EXECUTE FUNCTION "protect_product_stock_history"();
