/**
 * Privilege ceiling (ADR-0017). A caller may grant, revoke or reset on behalf of a role/user only if everything
 * that role/user can do is something the caller can do too. This stops a holder of, say, security.role.manage from
 * handing out (or taking away, or taking over) rights above their own.
 *
 * Pure functions so the rule is unit-testable without a database.
 */
export interface RolePermissions {
  id: string;
  permissionKeys: readonly string[];
}

/** Ids of the roles that contain at least one permission the caller does not hold. */
export function rolesOutsideCeiling(
  callerPermissions: ReadonlySet<string>,
  roles: readonly RolePermissions[],
): string[] {
  return roles
    .filter((r) => r.permissionKeys.some((k) => !callerPermissions.has(k)))
    .map((r) => r.id);
}

/** True when every permission of the subject is also held by the caller. */
export function withinCeiling(
  callerPermissions: ReadonlySet<string>,
  subjectPermissions: ReadonlySet<string>,
): boolean {
  for (const k of subjectPermissions) if (!callerPermissions.has(k)) return false;
  return true;
}

/** Symmetric difference of two id lists: what a replacement of `current` by `requested` adds and removes. */
export function diffIds(
  current: readonly string[],
  requested: readonly string[],
): { added: string[]; removed: string[] } {
  const cur = new Set(current);
  const req = new Set(requested);
  return {
    added: [...req].filter((id) => !cur.has(id)),
    removed: [...cur].filter((id) => !req.has(id)),
  };
}
