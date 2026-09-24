import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
// The seeder and the catalogue sync are the code under test's own code, and
// both take a Drizzle `Db`; registering the schema map is what makes them
// callable. This resolves no legacy identity table.
// eslint-disable-next-line no-restricted-imports -- see above
import * as schema from "../db/schema";
import type { Db } from "../db/drizzle.types";
import { PermissionCatalogSyncService } from "../modules/rbac/permission-catalog-sync.service";
import { seedSystemRolesForOrg } from "../modules/rbac/seed-system-roles";
import { ensureFixtureOrgs, type DbSpecOrg } from "./db-spec-fixture";
import { RoleGrantReconcilerService } from "../modules/rbac/role-grant-reconciler.service";
import { CronLeaseService } from "../modules/cron/cron-lease.service";

/**
 * The CRM data a real-database spec needs before it can assert anything.
 *
 * `db-spec-fixture.ts` is the inventory half of this: a fixed pair of
 * organisations and a small stock ledger, so a suite works on a freshly
 * migrated database rather than on whatever a shared branch happened to
 * contain. The five CRM database specs need the same floor and one thing more.
 *
 * Four of them opened with `SELECT id FROM organizations LIMIT 1` and threw
 * "CRM_DB_TESTS needs at least one organization to scope fixtures to" when it
 * came back empty; they plant their own parties, leads and activities, so an
 * organisation is the whole of what they were missing. `ensureCrmFixtureOrg`
 * is that, and it is `ensureFixtureOrgs` under a CRM-shaped name so the two
 * tiers cannot drift into two different notions of "the fixture tenant".
 *
 * The fifth — `crm-permissions-reach-somebody.db.spec.ts` — needs an
 * organisation whose *roles have been seeded*, and that is a different kind of
 * requirement. It asks whether every catalogued CRM key reaches a role in a
 * real database. On a migrated-but-empty database `roles` and
 * `role_permission_grants` are both empty, so the question has no subject:
 * three of its four assertions pass over zero rows and the fourth reports every
 * key in the catalogue as unreachable. Neither answer is about the seeder.
 */

/**
 * Raw SQL is the rule next door, and this file breaks it deliberately.
 *
 * `db-spec-fixture.ts` writes its organisations with hand-written SQL to stay
 * cheap to load. Copying that style here would mean re-implementing
 * `seedSystemRolesForOrg`'s grant logic in SQL — and then
 * `crm-permissions-reach-somebody` would be comparing the fixture's idea of
 * which keys reach a role against the fixture's own writes, which is a test of
 * nothing. A spec that asks "does the seeder cover the catalogue?" has to be
 * handed a database the seeder actually seeded. So the real service and the
 * real seeder are called, and the cost is that this module pulls in the schema
 * barrel; only the CRM specs import it.
 */

/** The fixture tenant, created once and reused. */
export async function ensureCrmFixtureOrg(
  client: ReturnType<typeof postgres>,
): Promise<DbSpecOrg> {
  const [org] = await ensureFixtureOrgs(client, 1);
  return org!;
}

/**
 * The permission catalogue and one organisation's system roles, as production
 * has them.
 *
 * Two steps, because a migrated database has neither. Migrations deliver 26 of
 * the 82 catalogued CRM and party keys — the rest arrive from
 * `PermissionCatalogSyncService`, which Nest runs at boot via `onModuleInit`,
 * and jest boots no app. `seedSystemRolesForOrg` then filters the keys it
 * grants through `resolveDbPermissionSet`, so seeding roles against a
 * half-delivered catalogue would grant a subset and prove only that the subset
 * agrees with itself. Sync first, then seed.
 *
 * Both are idempotent by construction — the sync is `ON CONFLICT DO UPDATE`
 * over a fixed catalogue and the seeder is `ON CONFLICT DO NOTHING` on
 * `(slug, org_id)` — so this is safe to call from `beforeAll` on a database
 * that already has it, and `cleanupRetired` is left off so the sync only ever
 * adds.
 */
export async function ensureSeededSystemRoles(
  client: ReturnType<typeof postgres>,
  orgId: string,
): Promise<{ catalogSize: number; rolesCreated: number }> {
  const db = drizzle(client, { schema }) as unknown as Db;

  const { catalogSize } = await new PermissionCatalogSyncService(
    db,
    new RoleGrantReconcilerService(db),
    new CronLeaseService(null),
  ).sync();
  const { created } = await seedSystemRolesForOrg(db, orgId);

  return { catalogSize, rolesCreated: created };
}

/** The fixture tenant with its roles seeded — what the RBAC probe needs. */
export async function ensureSeededCrmOrg(
  client: ReturnType<typeof postgres>,
): Promise<DbSpecOrg> {
  const org = await ensureCrmFixtureOrg(client);
  await ensureSeededSystemRoles(client, org.orgId);
  return org;
}
