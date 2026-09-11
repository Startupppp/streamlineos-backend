export const UNCATALOGUED_MODULE = "not_a_real_module";

const IN_ONE_HOUR = new Date(Date.now() + 3_600_000).toISOString();

const roleAssignment = (tx, f, assigner) => tx`
  INSERT INTO role_assignments (org_id, organization_membership_id, role_id, assigned_by_membership_id)
  VALUES (${f.orgA}, ${f.memberA}, ${f.roleA}, ${assigner})`;

const moduleOwnership = (tx, f, moduleKey) => tx`
  INSERT INTO module_ownerships (org_id, module_key, owner_membership_id)
  VALUES (${f.orgA}, ${moduleKey}, ${f.memberA})`;

const role = (tx, f, moduleKey) => tx`
  INSERT INTO roles (name, slug, org_id, module_key, rank)
  VALUES (${`Probe ${moduleKey} ${f.nonce}`}, ${`probe-${f.nonce}`}, ${f.orgA}, ${moduleKey}, 40)`;

const moduleAccess = (tx, f, moduleKey) => tx`
  INSERT INTO user_module_access (org_id, module_key, organization_membership_id)
  VALUES (${f.orgA}, ${moduleKey}, ${f.memberA})`;

const ownershipTransfer = (tx, f, moduleKey) => tx`
  INSERT INTO ownership_transfers
    (org_id, scope, module_key, from_membership_id, to_membership_id, initiated_by_membership_id, expires_at)
  VALUES (${f.orgA}, 'MODULE', ${moduleKey}, ${f.memberA}, ${f.memberA}, ${f.memberA}, ${IN_ONE_HOUR})`;

const permission = (tx, f, moduleKey) => tx`
  INSERT INTO permissions (name, resource, action, administering_module_key)
  VALUES (${`probe:${f.nonce}:view`}, 'probe', 'view', ${moduleKey})`;

const grant = (tx, f, permissionKey, moduleKey, granter = null) => tx`
  INSERT INTO user_permission_grants
    (org_id, organization_membership_id, permission_key, module_key, granted_by_membership_id)
  VALUES (${f.orgA}, ${f.memberA}, ${permissionKey}, ${moduleKey}, ${granter})`;

/**
 * Every probe names the SQLSTATE and the constraint it asserts. `verdict` fails the probe on
 * any other error — including the unique violation that used to score a pass here — and on a
 * write that is permitted when a rejection was claimed. Each of the nine REQUIRED_CONSTRAINTS
 * is bitten by at least one REJECT probe, and each REJECT is paired with an ACCEPT control
 * proving the constraint is not simply refusing everything.
 */
export const PROBE_SPECS = [
  {
    label: () => "role_assignments: assigner from another organization",
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_role_assignments_assigner_membership",
    run: (tx, f) => roleAssignment(tx, f, f.memberB),
  },
  {
    label: () => "role_assignments: assigner from the same organization [control]",
    expect: "ACCEPT",
    run: (tx, f) => roleAssignment(tx, f, f.memberA),
  },
  {
    label: () => "role_assignments: no assigner [control]",
    expect: "ACCEPT",
    run: (tx, f) => roleAssignment(tx, f, null),
  },
  {
    label: () => `module_ownerships: module '${UNCATALOGUED_MODULE}'`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_module_ownerships_module",
    run: (tx, f) => moduleOwnership(tx, f, UNCATALOGUED_MODULE),
  },
  {
    label: (c) => `module_ownerships: module '${c.hostModule}' [control]`,
    expect: "ACCEPT",
    run: (tx, f, c) => moduleOwnership(tx, f, c.hostModule),
  },
  {
    label: () => `roles: module '${UNCATALOGUED_MODULE}'`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_roles_module",
    run: (tx, f) => role(tx, f, UNCATALOGUED_MODULE),
  },
  {
    label: (c) => `roles: module '${c.hostModule}' [control]`,
    expect: "ACCEPT",
    run: (tx, f, c) => role(tx, f, c.hostModule),
  },
  {
    label: () => `user_module_access: module '${UNCATALOGUED_MODULE}'`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_user_module_access_module",
    run: (tx, f) => moduleAccess(tx, f, UNCATALOGUED_MODULE),
  },
  {
    label: (c) => `user_module_access: module '${c.hostModule}' [control]`,
    expect: "ACCEPT",
    run: (tx, f, c) => moduleAccess(tx, f, c.hostModule),
  },
  {
    label: () => `ownership_transfers: module '${UNCATALOGUED_MODULE}'`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_ownership_transfers_module",
    run: (tx, f) => ownershipTransfer(tx, f, UNCATALOGUED_MODULE),
  },
  {
    label: (c) => `ownership_transfers: module '${c.hostModule}' [control]`,
    expect: "ACCEPT",
    run: (tx, f, c) => ownershipTransfer(tx, f, c.hostModule),
  },
  {
    label: () => `permissions: administering module '${UNCATALOGUED_MODULE}'`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_permissions_administering_module",
    run: (tx, f) => permission(tx, f, UNCATALOGUED_MODULE),
  },
  {
    label: (c) => `permissions: administering module '${c.hostModule}' [control]`,
    expect: "ACCEPT",
    run: (tx, f, c) => permission(tx, f, c.hostModule),
  },
  {
    label: (c) => `user_permission_grants: '${c.permission}' under module '${UNCATALOGUED_MODULE}'`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_user_permission_grants_module",
    run: (tx, f, c) => grant(tx, f, c.permission, UNCATALOGUED_MODULE),
  },
  {
    label: (c) =>
      `user_permission_grants: '${c.permission}' under '${c.driftModule}' instead of its administering '${c.permissionModule}'`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_user_permission_grants_permission_module",
    run: (tx, f, c) => grant(tx, f, c.permission, c.driftModule),
  },
  {
    label: (c) => `user_permission_grants: '${c.permission}' under its administering '${c.permissionModule}' [control]`,
    expect: "ACCEPT",
    run: (tx, f, c) => grant(tx, f, c.permission, c.permissionModule),
  },
  {
    label: (c) => `user_permission_grants: '${c.unadministered}' has no administering module and is not grantable`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_user_permission_grants_permission_module",
    run: (tx, f, c) => grant(tx, f, c.unadministered, c.hostModule),
  },
  {
    label: (c) => `user_permission_grants: granter from another organization ('${c.permission}')`,
    expect: "REJECT",
    sqlstate: "23503",
    constraint: "fk_user_permission_grants_granter_membership",
    run: (tx, f, c) => grant(tx, f, c.permission, c.permissionModule, f.memberB),
  },
  {
    label: (c) => `user_permission_grants: granter from the same organization ('${c.permission}') [control]`,
    expect: "ACCEPT",
    run: (tx, f, c) => grant(tx, f, c.permission, c.permissionModule, f.memberA),
  },
];
