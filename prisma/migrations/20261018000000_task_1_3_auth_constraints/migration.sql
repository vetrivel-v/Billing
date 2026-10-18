-- Task 1.3: database-level guarantees for authentication. No table or column changes (schema.prisma is
-- unchanged); constraints and triggers only. Forward-only.
--
-- Pre-existing data: usernames are folded to lower case / trimmed first. If that makes two usernames in one
-- organization identical, or a name is shorter than 3 or longer than 64 characters, the migration ABORTS
-- (it never guesses). No user rows can exist before Task 1.3, so this is a safety net only.

UPDATE "users" SET "username" = lower(btrim("username")) WHERE "username" <> lower(btrim("username"));

-- Usernames are stored in their canonical form so case-insensitive login cannot be bypassed by duplicates.
ALTER TABLE "users"
  ADD CONSTRAINT "users_username_form_chk"
  CHECK ("username" = lower(btrim("username")) AND char_length("username") BETWEEN 3 AND 64);

-- Only the SHA-256 hex of a session token may be stored; a raw (base64url) token is rejected by the database.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_token_hash_form_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "sessions_expiry_chk" CHECK ("expires_at" > "created_at");

-- Users are never physically deleted (history and audit records refer to them): disable the account instead.
CREATE FUNCTION "users_block_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'users cannot be deleted: disable the account instead (% is not permitted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "users_no_delete"
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "users_block_delete"();
