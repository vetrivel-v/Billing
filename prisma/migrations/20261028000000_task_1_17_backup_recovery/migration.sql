-- Task 1.17: backup and verified restore records. backup_records lists the backup files that were created; backup_verifications records
-- each verified-restore run (PASS/FAIL). Both are append-only (a record's file_deleted_at can be set once, by retention). Nothing here
-- holds a passphrase, a key, a path or any business data. Existing data is untouched. Forward-only.

-- CreateTable
CREATE TABLE "backup_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "destination_label" TEXT,
    "size_bytes" BIGINT NOT NULL,
    "app_version" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "backup_format" INTEGER NOT NULL,
    "database_id" UUID NOT NULL,
    "manifest_sha256" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,
    "file_deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "backup_id" UUID NOT NULL,
    "result" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "database_id" UUID NOT NULL,
    "verified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB NOT NULL,
    "verified_by" UUID,

    CONSTRAINT "backup_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "backup_records_seq_key" ON "backup_records"("seq");
CREATE UNIQUE INDEX "backup_verifications_seq_key" ON "backup_verifications"("seq");
CREATE UNIQUE INDEX "backup_records_id_organization_id_key" ON "backup_records"("id", "organization_id");
CREATE INDEX "backup_records_organization_id_created_at_idx" ON "backup_records"("organization_id", "created_at" DESC);
CREATE INDEX "backup_verifications_organization_id_verified_at_idx" ON "backup_verifications"("organization_id", "verified_at" DESC);

-- AddForeignKey
ALTER TABLE "backup_records" ADD CONSTRAINT "backup_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "backup_records" ADD CONSTRAINT "backup_records_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_backup_id_organization_id_fkey" FOREIGN KEY ("backup_id", "organization_id") REFERENCES "backup_records"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Value rules
ALTER TABLE "backup_records"
  ADD CONSTRAINT "backup_records_kind_valid" CHECK ("kind" IN ('MANUAL', 'PRE_RESTORE')),
  ADD CONSTRAINT "backup_records_file_name_form" CHECK ("file_name" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.cbbackup$'),
  ADD CONSTRAINT "backup_records_size_positive" CHECK ("size_bytes" > 0),
  ADD CONSTRAINT "backup_records_format_positive" CHECK ("backup_format" >= 1),
  ADD CONSTRAINT "backup_records_manifest_form" CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "backup_records_label_form" CHECK ("destination_label" IS NULL OR char_length("destination_label") <= 80);
ALTER TABLE "backup_verifications"
  ADD CONSTRAINT "backup_verifications_result_valid" CHECK ("result" IN ('PASS', 'FAIL'));

-- Append-only: a verification never changes; a backup record changes only to note, once, that its file was removed by retention.
CREATE FUNCTION "backup_verifications_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'backup verification records are immutable: they cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "backup_verifications_no_change" BEFORE UPDATE OR DELETE ON "backup_verifications"
  FOR EACH ROW EXECUTE FUNCTION "backup_verifications_immutable"();
CREATE TRIGGER "backup_verifications_no_truncate" BEFORE TRUNCATE ON "backup_verifications"
  FOR EACH STATEMENT EXECUTE FUNCTION "backup_verifications_immutable"();

CREATE FUNCTION "backup_records_protect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'backup records are immutable: they cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."file_deleted_at" IS NOT NULL
     OR NEW."file_deleted_at" IS NULL
     OR (to_jsonb(NEW) - 'file_deleted_at') IS DISTINCT FROM (to_jsonb(OLD) - 'file_deleted_at') THEN
    RAISE EXCEPTION 'backup records are immutable: only the one-time removal of the file is recorded' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "backup_records_no_change" BEFORE UPDATE OR DELETE ON "backup_records"
  FOR EACH ROW EXECUTE FUNCTION "backup_records_protect"();
CREATE TRIGGER "backup_records_no_truncate" BEFORE TRUNCATE ON "backup_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "backup_records_protect"();

-- Everything a backup record points at belongs to its organization. created_by / verified_by are NULL only for history carried into a
-- restored database whose users did not include the person (they were created after the backup): "unknown here", never a guess.
CREATE FUNCTION "check_backup_record"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_org uuid;
BEGIN
  IF NEW."created_by" IS NOT NULL THEN
    SELECT "organization_id" INTO ref_org FROM "users" WHERE "id" = NEW."created_by";
    IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the user belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "backup_records_check" BEFORE INSERT ON "backup_records"
  FOR EACH ROW EXECUTE FUNCTION "check_backup_record"();

CREATE FUNCTION "check_backup_verification"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_org uuid;
  rec record;
BEGIN
  IF NEW."verified_by" IS NOT NULL THEN
    SELECT "organization_id" INTO ref_org FROM "users" WHERE "id" = NEW."verified_by";
    IF ref_org IS DISTINCT FROM NEW."organization_id" THEN RAISE EXCEPTION 'the user belongs to another organization' USING ERRCODE = 'foreign_key_violation'; END IF;
  END IF;
  SELECT "database_id" INTO rec FROM "backup_records" WHERE "id" = NEW."backup_id";
  IF rec."database_id" IS DISTINCT FROM NEW."database_id" THEN
    RAISE EXCEPTION 'a verification must carry the database identity of the backup it verified' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "backup_verifications_check" BEFORE INSERT ON "backup_verifications"
  FOR EACH ROW EXECUTE FUNCTION "check_backup_verification"();
