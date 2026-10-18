-- Task 1.6: database-level protection of the last usable security administrator, per organization.
-- No table or column changes (schema.prisma is unchanged); one function, one trigger function and deferred
-- constraint triggers. Forward-only.
--
-- INVARIANT: every organization whose first-run setup is complete (organizations.setup_completed_at IS NOT NULL)
-- must always have at least one ACTIVE user who holds, through roles of that same organization, BOTH
-- security.user.manage and security.role.manage. The rule is based on permission keys, not on the role name
-- "Administrator". It is checked at COMMIT (deferred), so multi-statement changes such as "swap roles" work, and a
-- violating transaction is rolled back as a whole.
--
-- Organizations without a completed setup (tests, imports) are exempt. Existing organizations are NOT scanned here:
-- the rule applies to changes made from now on.

CREATE FUNCTION "organization_security_admin_count"(p_org uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer
    FROM "users" u
   WHERE u."organization_id" = p_org
     AND u."is_active"
     AND EXISTS (
       SELECT 1
         FROM "user_roles" ur
         JOIN "roles" r ON r."id" = ur."role_id" AND r."organization_id" = p_org
         JOIN "role_permissions" rp ON rp."role_id" = r."id"
         JOIN "permissions" p ON p."id" = rp."permission_id"
        WHERE ur."user_id" = u."id" AND p."key" = 'security.user.manage')
     AND EXISTS (
       SELECT 1
         FROM "user_roles" ur
         JOIN "roles" r ON r."id" = ur."role_id" AND r."organization_id" = p_org
         JOIN "role_permissions" rp ON rp."role_id" = r."id"
         JOIN "permissions" p ON p."id" = rp."permission_id"
        WHERE ur."user_id" = u."id" AND p."key" = 'security.role.manage');
$$;

CREATE FUNCTION "enforce_security_administrator"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  orgs uuid[] := ARRAY[]::uuid[];
  o uuid;
BEGIN
  -- Which organizations could this row change have affected?
  IF TG_TABLE_NAME = 'users' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN orgs := orgs || OLD."organization_id"; END IF;
    IF TG_OP IN ('UPDATE', 'INSERT') THEN orgs := orgs || NEW."organization_id"; END IF;
  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      orgs := orgs || (SELECT "organization_id" FROM "users" WHERE "id" = OLD."user_id")
                   || (SELECT "organization_id" FROM "roles" WHERE "id" = OLD."role_id");
    END IF;
    IF TG_OP IN ('UPDATE', 'INSERT') THEN
      orgs := orgs || (SELECT "organization_id" FROM "users" WHERE "id" = NEW."user_id")
                   || (SELECT "organization_id" FROM "roles" WHERE "id" = NEW."role_id");
    END IF;
  ELSIF TG_TABLE_NAME = 'role_permissions' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      orgs := orgs || (SELECT "organization_id" FROM "roles" WHERE "id" = OLD."role_id");
    END IF;
    IF TG_OP IN ('UPDATE', 'INSERT') THEN
      orgs := orgs || (SELECT "organization_id" FROM "roles" WHERE "id" = NEW."role_id");
    END IF;
  ELSIF TG_TABLE_NAME = 'roles' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN orgs := orgs || OLD."organization_id"; END IF;
    IF TG_OP IN ('UPDATE', 'INSERT') THEN orgs := orgs || NEW."organization_id"; END IF;
  ELSE
    -- permissions: renaming a permission key could remove the capability everywhere.
    orgs := ARRAY(SELECT "id" FROM "organizations" WHERE "setup_completed_at" IS NOT NULL);
  END IF;

  FOR o IN SELECT DISTINCT x FROM unnest(orgs) AS x WHERE x IS NOT NULL ORDER BY x LOOP
    -- Serialise concurrent checks for the same organization. Without this, two transactions that each remove a
    -- different administrator would both pass at commit because neither sees the other's uncommitted change. The
    -- lock is held until commit finishes, so the second check runs on a fresh snapshot that includes the first.
    PERFORM pg_advisory_xact_lock(hashtextextended('secadmin:' || o::text, 0));
    IF EXISTS (SELECT 1 FROM "organizations" WHERE "id" = o AND "setup_completed_at" IS NOT NULL)
       AND "organization_security_admin_count"(o) = 0 THEN
      RAISE EXCEPTION 'organization % must keep at least one active user holding security.user.manage and security.role.manage', o
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "users_keep_security_admin"
  AFTER UPDATE OF "is_active", "organization_id" ON "users"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."is_active" IS DISTINCT FROM NEW."is_active" OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id")
  EXECUTE FUNCTION "enforce_security_administrator"();

CREATE CONSTRAINT TRIGGER "user_roles_keep_security_admin"
  AFTER UPDATE OR DELETE ON "user_roles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_security_administrator"();

CREATE CONSTRAINT TRIGGER "role_permissions_keep_security_admin"
  AFTER UPDATE OR DELETE ON "role_permissions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_security_administrator"();

CREATE CONSTRAINT TRIGGER "roles_keep_security_admin"
  AFTER UPDATE OF "organization_id" ON "roles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."organization_id" IS DISTINCT FROM NEW."organization_id")
  EXECUTE FUNCTION "enforce_security_administrator"();

CREATE CONSTRAINT TRIGGER "permissions_keep_security_admin"
  AFTER UPDATE OF "key" ON "permissions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."key" IS DISTINCT FROM NEW."key")
  EXECUTE FUNCTION "enforce_security_administrator"();
