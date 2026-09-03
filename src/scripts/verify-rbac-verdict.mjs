const NAMESPACE_TO_MODULE = new Map([
  ["home", "home"],
  ["chat", "home"],
  ["mail", "home"],
  ["calendar", "home"],
  ["notifications", "home"],
  ["crm", "crm"],
  ["party", "crm"],
]);

export function administeringModuleOf(permissionKey) {
  const namespace = permissionKey.split(":")[0] ?? "";
  return NAMESPACE_TO_MODULE.get(namespace) ?? namespace;
}

export const REQUIRED_CONSTRAINTS = [
  "fk_permissions_administering_module",
  "fk_role_assignments_assigner_membership",
  "fk_user_permission_grants_granter_membership",
  "fk_roles_module",
  "fk_module_ownerships_module",
  "fk_ownership_transfers_module",
  "fk_user_module_access_module",
  "fk_user_permission_grants_module",
  "fk_user_permission_grants_permission_module",
];

/**
 * postgres-js raises a bare `PostgresError` carrying `.code` and `.constraint_name`.
 * drizzle-orm 0.45.2 wraps that in a `DrizzleQueryError` which has NEITHER and hangs the driver
 * error off `.cause`; node-postgres spells the same fields `constraint` / `table`. Reading only
 * `err.code` is how a check silently matches nothing, so read all three shapes.
 */
export function sqlErrorShape(error) {
  let node = error;
  for (let depth = 0; node !== null && node !== undefined && depth < 4; depth += 1) {
    if (typeof node.code === "string" && node.code.length > 0)
      return {
        code: node.code,
        constraint: node.constraint_name ?? node.constraint ?? null,
        table: node.table_name ?? node.table ?? null,
        message: String(node.message ?? ""),
      };
    node = node.cause;
  }
  return { code: null, constraint: null, table: null, message: String(error?.message ?? error) };
}

export function describeError(error) {
  const shape = sqlErrorShape(error);
  if (shape.code === null) return `a non-Postgres error (${shape.message})`;
  return `SQLSTATE ${shape.code} on ${shape.constraint ?? "an unnamed constraint"}`;
}

/**
 * A probe passes ONLY for the reason it claims. A REJECT must carry the exact SQLSTATE and the
 * exact constraint under test; a unique violation, a not-null violation, a syntax error, a
 * missing table and a failure while building the fixture are all probe FAILURES, never passes.
 */
export function verdict(spec, observed) {
  if (observed.phase === "fixture")
    return { pass: false, why: `the fixture failed before the probe ran — ${describeError(observed.error)}` };
  if (spec.expect === "ACCEPT") {
    if (observed.error === null) return { pass: true, why: "permitted" };
    return { pass: false, why: `expected the write to be permitted; it was rejected with ${describeError(observed.error)}` };
  }
  const claim = `${spec.sqlstate} on ${spec.constraint}`;
  if (observed.error === null) return { pass: false, why: `expected ${claim}; the write was PERMITTED` };
  const shape = sqlErrorShape(observed.error);
  if (shape.code !== spec.sqlstate || shape.constraint !== spec.constraint)
    return { pass: false, why: `expected ${claim}; got ${describeError(observed.error)}` };
  return { pass: true, why: `${shape.code} on ${shape.constraint}` };
}
