import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Place an internal or test organization in a cell, and record the placement in
the control plane. The organization's rows are written in the cell's database;
only the routing record lives in the control plane.

  node src/scripts/place-cell-org.mjs [--region=cell-2] [--kind=internal] [--name="Internal QA"]
  node src/scripts/place-cell-org.mjs --region=cell-2 --list

The organization id is printed on the last line so a caller can pipe it.
`);
  process.exit(0);
}

const topology = parseCellArgs(argv, env);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const KIND = flag("kind", "internal");
const NAME = flag("name", `${KIND === "test" ? "Cell Test" : "Cell Internal"} ${topology.cellId}`);
const LIST = argv.includes("--list");

if (env.NODE_ENV === "production") {
  console.error("Refusing to place a synthetic organization against NODE_ENV=production.");
  process.exit(1);
}

if (!["internal", "test"].includes(KIND)) {
  console.error(`--kind must be internal or test, not "${KIND}".`);
  process.exit(1);
}

const FENCE_LEASE_MS = 24 * 60 * 60 * 1000;

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

async function list() {
  const control = connect(topology.controlPlane.ownerDirect);
  try {
    const rows = await control`
      SELECT organization_id, region, cell_id, status, placement_version, lease_expires_at
      FROM organization_placement
      WHERE cell_id = ${topology.cellId}
      ORDER BY organization_id`;
    if (rows.length === 0) {
      console.log(`No organization is placed in ${topology.cellId}.`);
      return;
    }
    for (const r of rows)
      console.log(
        `${r.organization_id}  region=${r.region}  status=${r.status}` +
          `  v${r.placement_version}  lease=${new Date(r.lease_expires_at).toISOString()}`,
      );
    console.log(`\n${rows.length} organization(s) placed in ${topology.cellId}.`);
  } finally {
    await control.end();
  }
}

async function createInCell(orgId, userId, slug, email) {
  const cell = connect(topology.cell.ownerDirect);
  try {
    await cell.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
      await tx`
        INSERT INTO users (id, name, email, first_name, last_name, is_active, user_status)
        VALUES (${userId}, ${NAME + " Owner"}, ${email}, ${"Cell"}, ${"Owner"}, true, 'active')
        ON CONFLICT (id) DO NOTHING`;
      await tx`
        INSERT INTO organizations (id, name, slug, region, owner_membership_id, status, status_v2)
        VALUES (${orgId}, ${NAME}, ${slug}, ${topology.regionKey}, 0, 'ACTIVE', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING`;
      const [member] = await tx`
        INSERT INTO organization_members (user_id, org_id, role, is_owner, status, activated_at)
        VALUES (${userId}, ${orgId}, 'OWNER', true, 'ACTIVE', now())
        ON CONFLICT (user_id, org_id) DO UPDATE SET status = 'ACTIVE'
        RETURNING id`;
      await tx`
        UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    });
  } finally {
    await cell.end();
  }
}

async function recordPlacement(orgId) {
  const control = connect(topology.controlPlane.ownerDirect);
  try {
    const [row] = await control`
      INSERT INTO organization_placement (
        organization_id, region, cell_id, database_shard, object_storage_region,
        search_cluster, placement_version, write_fence_token, lease_expires_at, status)
      VALUES (
        ${orgId}, ${topology.regionKey}, ${topology.cellId}, ${topology.cellId},
        ${env.R2_REGION ?? "auto"}, ${topology.cellId}, 1, ${randomUUID()},
        ${new Date(Date.now() + FENCE_LEASE_MS)}, 'ACTIVE')
      ON CONFLICT (organization_id) DO UPDATE SET
        region = excluded.region,
        cell_id = excluded.cell_id,
        database_shard = excluded.database_shard,
        search_cluster = excluded.search_cluster,
        placement_version = organization_placement.placement_version + 1,
        write_fence_token = excluded.write_fence_token,
        lease_expires_at = excluded.lease_expires_at,
        status = 'ACTIVE'
      RETURNING placement_version, write_fence_token`;
    return row;
  } finally {
    await control.end();
  }
}

async function readBackAsAppRole(orgId) {
  const app = connect(topology.cell.app);
  try {
    return await app.begin(async (tx) => {
      const [{ current_user: role }] = await tx`SELECT current_user`;
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
      const orgs = await tx`SELECT id, name, region FROM organizations WHERE id = ${orgId}`;
      const members = await tx`
        SELECT count(*)::int AS n FROM organization_members WHERE org_id = ${orgId}`;
      return { role, org: orgs[0] ?? null, members: Number(members[0].n) };
    });
  } finally {
    await app.end();
  }
}

async function absentFromControlPlane(orgId) {
  const control = connect(topology.controlPlane.ownerDirect);
  try {
    const rows = await control`SELECT id FROM organizations WHERE id = ${orgId}`;
    return rows.length === 0;
  } finally {
    await control.end();
  }
}

async function main() {
  console.log(`cell        : ${topology.cellId}`);
  console.log(`cell db     : ${redact(topology.cell.ownerDirect)}`);
  console.log(`control db  : ${redact(topology.controlPlane.ownerDirect)}\n`);

  if (LIST) return list();

  const orgId = flag("org", randomUUID());
  const userId = `cell-owner-${orgId.slice(0, 8)}`;
  const slug = `${KIND}-${topology.cellId}-${orgId.slice(0, 8)}`;
  const email = `${slug}@cells.invalid`;

  await createInCell(orgId, userId, slug, email);
  console.log(`created organization ${orgId} inside ${topology.cell.database}`);

  const placement = await recordPlacement(orgId);
  console.log(
    `recorded placement in the control plane: v${placement.placement_version}` +
      ` fence=${placement.write_fence_token.slice(0, 8)}`,
  );

  const readBack = await readBackAsAppRole(orgId);
  const onlyInCell = await absentFromControlPlane(orgId);

  const served = readBack.org !== null && readBack.members > 0 && readBack.role === "streamline_app";

  console.log(
    `read back as ${readBack.role} with the tenant GUC: ` +
      `${readBack.org ? `org "${readBack.org.name}" region=${readBack.org.region}` : "NOT VISIBLE"}` +
      `, ${readBack.members} member(s)`,
  );
  console.log(
    `absent from the control-plane database: ${onlyInCell ? "yes" : "NO — the row exists in both"}`,
  );

  if (!served || !onlyInCell) {
    console.error("\nRESULT: PLACEMENT FAILED — the cell did not serve the organization it was given.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nRESULT: PLACED kind=${KIND} cell=${topology.cellId}` +
      ` served-by-app-role=yes only-in-cell=yes`,
  );
  console.log(orgId);
}

main().catch((e) => {
  console.error("PLACE CELL ORG FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
