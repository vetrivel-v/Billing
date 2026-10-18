-- Task 1.4: database-level invariants for first-run setup. No table or column changes (schema.prisma is
-- unchanged); constraints and a trigger only. Forward-only.
--
-- Pre-existing rows are NOT rewritten: if any organization violates a rule below the migration ABORTS
-- atomically rather than guessing. Before Task 1.4 organizations were only created by tests.

-- Identifier formats mirror the application validators (format only; checksums stay in the application).
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_pan_form_chk"
    CHECK ("pan" IS NULL OR "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  ADD CONSTRAINT "organizations_gstin_form_chk"
    CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD CONSTRAINT "organizations_state_code_form_chk"
    CHECK ("state_code" IS NULL OR "state_code" ~ '^[0-9]{2}$'),
  -- Approved GST status rules: registered requires a GSTIN; unregistered must not have one.
  ADD CONSTRAINT "organizations_gst_status_gstin_chk"
    CHECK (("gst_status" <> 'REGISTERED' OR "gstin" IS NOT NULL)
       AND ("gst_status" <> 'UNREGISTERED' OR "gstin" IS NULL)),
  -- A GSTIN starts with the state code and embeds the PAN.
  ADD CONSTRAINT "organizations_gstin_state_chk"
    CHECK ("gstin" IS NULL OR "state_code" IS NULL OR substr("gstin", 1, 2) = "state_code"),
  ADD CONSTRAINT "organizations_gstin_pan_chk"
    CHECK ("gstin" IS NULL OR "pan" IS NULL OR substr("gstin", 3, 10) = "pan");

-- Completion is irreversible and tamper-evident: once setup_completed_at is set it can never be cleared or
-- changed, so "setup complete" cannot be silently re-opened through the database either.
CREATE FUNCTION "organizations_setup_completed_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."setup_completed_at" IS NOT NULL
     AND NEW."setup_completed_at" IS DISTINCT FROM OLD."setup_completed_at" THEN
    RAISE EXCEPTION 'setup_completed_at is immutable once set'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "organizations_setup_completed_immutable"
  BEFORE UPDATE ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION "organizations_setup_completed_immutable"();
