import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import postgres from "postgres";
import {
  IMPORT_ENTITY_PERMISSIONS,
  IMPORT_PERMISSION,
} from "../../crm/import/import-permissions";

/**
 * The invariant that this programme has broken twice, checked where the truth is.
 *
 * A permission key added to the catalogue is granted to a *new* organisation
 * automatically, because `seedSystemRolesForOrg` hands out the module's whole
 * namespace at role-creation time. An organisation that already exists gets it
 * only from a backfill migration — and `seedSystemRolesForOrg` cannot help it
 * later, since it grants solely on creation (`if (inserted.length > 0)`).
 *
 * So the failure is silent by construction. `ON CONFLICT DO NOTHING` over an
 * empty result set is a clean migration: nothing errors, nothing warns, and the
 * feature is simply unreachable for every existing tenant.
 *
 * It has happened twice here. Seven CRM backfills targeted `CRM_ADMIN`, a
 * `ROLE_TEMPLATES` slug the seeder never mints, leaving eighteen permissions
 * granted to nobody. The repair migration then missed two of them and asserted
 * its own completeness in a comment, so the unified activity timeline returned
 * 403 for every user in every existing organisation while the suite stayed green.
 *
 * `backfill-slugs-exist.spec.ts` catches both of those *statically*, by reading
 * migration SQL. What it cannot see is the outcome — whether a key actually
 * reaches a role in a real database. That is what this file is for, and it is
 * why it needs a database rather than a fixture.
 *
 * Run via `pnpm test:db-specs` (jest-db.json).
 */

describe("every CRM permission reaches somebody", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    const url = requireApprovedDatabaseUrl({
      spec: "crm-permissions-reach-somebody.db.spec.ts",
      vars: ["DATABASE_URL"],
    });
    sql = postgres(url, { max: 1, prepare: false });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("grants every catalogued CRM and party key to at least one role", async () => {
    const orphans = await sql<{ name: string }[]>`
      SELECT p."name"
      FROM "permissions" p
      WHERE (p."name" LIKE 'crm:%' OR p."name" LIKE 'party:%')
        AND NOT EXISTS (
          SELECT 1 FROM "role_permission_grants" g WHERE g."permission_key" = p."name"
        )
      ORDER BY 1
    `;

    // A key here is in the catalogue, gated on an endpoint, and held by nobody.
    // The fix is a backfill migration targeting `${MODULE}_MODULE_OWNER|ADMIN|MEMBER`,
    // never a `ROLE_TEMPLATES` slug.
    expect(orphans.map((row) => row.name)).toEqual([]);
  });

  /**
   * The importer writes four tables now, and the check that says so has to hold.
   *
   * `crm:imports:manage` authorises running an import; `IMPORT_ENTITY_PERMISSIONS`
   * says the caller must also hold the right to write the thing the file IS.
   * That is a new refusal, and a new refusal that nobody can satisfy is an
   * outage rather than a guard — so the claim is measured here rather than
   * reasoned about from the catalogue. A catalogue grep would say all five keys
   * exist and tell you nothing about who holds them.
   *
   * `party:` keys are reachable for a CRM role by design, not by accident:
   * `MODULE_REGISTRY` gives the CRM module `administersNamespaces: ["party"]`
   * so a CRM administrator can manage the customers their deals point at.
   *
   * The party row is the one that would be a REGRESSION rather than a new
   * restriction — party import ships today on `crm:imports:manage` alone — so it
   * is asserted with the rest rather than assumed.
   */
  it("lets everyone who can import also write what they are importing", async () => {
    const entityKeys = Object.values(IMPORT_ENTITY_PERMISSIONS);

    const gaps = await sql<{ slug: string; org_id: string; missing: string }[]>`
      SELECT r."slug", g."org_id", k."key" AS missing
      FROM "role_permission_grants" g
      JOIN "roles" r ON r."id" = g."role_id"
      CROSS JOIN unnest(${sql.array(entityKeys)}::text[]) AS k("key")
      WHERE g."permission_key" = ${IMPORT_PERMISSION}
        AND NOT EXISTS (
          SELECT 1
          FROM "role_permission_grants" held
          WHERE held."role_id" = g."role_id"
            AND held."permission_key" = k."key"
        )
      ORDER BY 1, 3
    `;

    // A role that may start an import but may not write what the import writes.
    // The fix is a backfill migration targeting `${MODULE}_MODULE_OWNER|ADMIN`,
    // never a `ROLE_TEMPLATES` slug — or dropping the entity check for that key.
    expect(gaps.map((row) => `${row.slug}: ${row.missing}`)).toEqual([]);
  });

  it("gives members read keys only", async () => {
    const writeKeys = await sql<{ permission_key: string }[]>`
      SELECT DISTINCT g."permission_key"
      FROM "role_permission_grants" g
      JOIN "roles" r ON r."id" = g."role_id"
      WHERE r."slug" = 'CRM_MODULE_MEMBER'
        AND (g."permission_key" LIKE 'crm:%' OR g."permission_key" LIKE 'party:%')
        AND g."permission_key" NOT LIKE '%:view'
        AND g."permission_key" NOT LIKE '%:read'
      ORDER BY 1
    `;

    // `buildModuleMemberPermissionKeys` filters the namespace to keys ending
    // `:view` or `:read`. A member holding anything else came from a backfill
    // that did not match what a fresh seed produces.
    expect(writeKeys.map((row) => row.permission_key)).toEqual([]);
  });

  it("does not let a backfilled organisation differ from a newly seeded one", async () => {
    const drift = await sql<{ permission_key: string }[]>`
      SELECT DISTINCT a."permission_key"
      FROM "role_permission_grants" a
      JOIN "roles" ra ON ra."id" = a."role_id"
      WHERE ra."slug" = 'CRM_MODULE_ADMIN'
        AND (a."permission_key" LIKE 'crm:%' OR a."permission_key" LIKE 'party:%')
        AND (a."permission_key" LIKE '%:view' OR a."permission_key" LIKE '%:read')
        AND NOT EXISTS (
          SELECT 1
          FROM "role_permission_grants" m
          JOIN "roles" rm ON rm."id" = m."role_id"
          WHERE rm."slug" = 'CRM_MODULE_MEMBER'
            AND m."permission_key" = a."permission_key"
            AND m."org_id" = a."org_id"
        )
      ORDER BY 1
    `;

    /**
     * A read key an admin holds and a member does not, in the same organisation.
     *
     * A fresh seed gives members every `:view` key in the namespace, so a gap
     * here means one tenant's members can see something another tenant's cannot,
     * decided by when they signed up rather than by anything they chose. That is
     * the divergence migration 0226 says it exists to prevent — and then caused,
     * by omitting `crm:activities:view` from its member list.
     */
    expect(drift.map((row) => row.permission_key)).toEqual([]);
  });
});
