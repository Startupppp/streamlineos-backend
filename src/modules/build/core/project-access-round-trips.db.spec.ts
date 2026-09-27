import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { resolveProjectAccess } from "./project-access";
import type { Db } from "../../../db/drizzle.types";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

type Sql = ReturnType<typeof postgres>;

interface Fixture {
  orgId: string;
  ownerUserId: string;
  directUserId: string;
  teamUserId: string;
  deniedUserId: string;
  ownerMembershipId: number;
  directMembershipId: number;
  teamMembershipId: number;
  deniedMembershipId: number;
  projectId: number;
}

function actor(f: Fixture, userId: string, membershipId: number): CurrentUserContext {
  return {
    orgId: f.orgId,
    userId,
    membershipId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: `sess-${userId}`,
    tokenScopes: null,
    principal: { kind: "human-session", membershipId, isOrgOwner: false },
  } as unknown as CurrentUserContext;
}

async function seed(sql: Sql): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `parc-${tag}`;
  const ids = {
    owner: `parc-o-${tag}`,
    direct: `parc-d-${tag}`,
    team: `parc-t-${tag}`,
    denied: `parc-x-${tag}`,
  };

  return sql.begin(async (tx) => {
    for (const userId of Object.values(ids)) {
      await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'Access Cost Fixture')`;
    }
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id, currency)
      VALUES (${orgId}, ${`AccessCost ${tag}`}, ${orgId}, 1, 'USD')
    `;
    const memberships: Record<string, number> = {};
    for (const [key, userId] of Object.entries(ids)) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
        VALUES (${userId}, ${orgId}, ${key === "owner" ? "OWNER" : "MEMBER"}, ${key === "owner"}, 'ACTIVE')
        RETURNING id
      `;
      memberships[key] = row.id;
    }
    await tx`UPDATE organizations SET owner_membership_id = ${memberships.owner} WHERE id = ${orgId}`;

    const [project] = await tx<{ id: number }[]>`
      INSERT INTO build.projects (org_id, name, key, manager_membership_id)
      VALUES (${orgId}, ${`PARC ${tag}`}, ${`PA${tag.slice(0, 4).toUpperCase()}`}, ${memberships.owner})
      RETURNING id
    `;

    await tx`
      INSERT INTO build.project_members (org_id, project_id, membership_id, role)
      VALUES (${orgId}, ${project.id}, ${memberships.direct}, 'MEMBER')
    `;

    const [team] = await tx<{ id: number }[]>`
      INSERT INTO build.project_teams (org_id, name, key)
      VALUES (${orgId}, ${`Team ${tag}`}, ${`T${tag.slice(0, 6).toUpperCase()}`})
      RETURNING id
    `;
    await tx`
      INSERT INTO build.project_team_members (org_id, team_id, membership_id)
      VALUES (${orgId}, ${team.id}, ${memberships.team})
    `;
    await tx`
      INSERT INTO build.project_team_assignments (org_id, team_id, project_id)
      VALUES (${orgId}, ${team.id}, ${project.id})
    `;

    return {
      orgId,
      ownerUserId: ids.owner,
      directUserId: ids.direct,
      teamUserId: ids.team,
      deniedUserId: ids.denied,
      ownerMembershipId: memberships.owner,
      directMembershipId: memberships.direct,
      teamMembershipId: memberships.team,
      deniedMembershipId: memberships.denied,
      projectId: project.id,
    };
  });
}

async function drop(sql: Sql, f: Fixture | undefined): Promise<void> {
  if (!f) return;
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM organizations WHERE id = ${f.orgId}`;
    await tx`DELETE FROM organization_members WHERE org_id = ${f.orgId}`;
    await tx`DELETE FROM users WHERE id = ANY(${[f.ownerUserId, f.directUserId, f.teamUserId, f.deniedUserId]})`;
  });
}

describe("resolveProjectAccess round trips and duration, measured against a real database rather than inferred from deduplication", () => {
  let rawSql: Sql;
  let db: Db;
  let fixture: Fixture | undefined;
  const statements: string[] = [];
  const measured: { path: string; statements: number; ms: number; hasAccess: boolean; role: string | null }[] = [];

  const access = {
    resolveUserPermissions: async () => new Set<string>(),
  } as unknown as AccessService;

  beforeAll(async () => {
    const url = requireApprovedDatabaseUrl({
      spec: "project-access-round-trips.db.spec.ts",
      vars: ["DATABASE_URL"],
    });
    rawSql = postgres(url, {
      max: 2,
      prepare: false,
      debug: (_connection, query) => {
        statements.push(query);
      },
    });
    db = drizzle(rawSql, { schema });
    fixture = await seed(rawSql);
    await rawSql`SELECT 1`;
    await resolveProjectAccess(db, access, actor(fixture, fixture.directUserId, fixture.directMembershipId), fixture.projectId);
  }, 60_000);

  afterAll(async () => {
    await drop(rawSql, fixture);
    await rawSql?.end({ timeout: 5 });
    if (measured.length > 0) {
      const rows = measured
        .map((m) => `  ${m.path.padEnd(14)} statements=${m.statements}  ${m.ms.toFixed(1)}ms  access=${m.hasAccess} role=${m.role}`)
        .join("\n");
      process.stdout.write(`\nresolveProjectAccess measured round trips:\n${rows}\n`);
    }
  }, 60_000);

  async function measure(path: string, u: CurrentUserContext) {
    statements.length = 0;
    const started = performance.now();
    const result = await resolveProjectAccess(db, access, u, fixture!.projectId);
    const ms = performance.now() - started;
    const count = statements.length;
    measured.push({ path, statements: count, ms, hasAccess: result.hasAccess, role: result.role });
    return { result, count, ms };
  }

  it("grants a direct project member in three statements, measured on a warmed connection so first-call setup traffic is not counted as an access round trip", async () => {
    const { result, count } = await measure("direct-member", actor(fixture!, fixture!.directUserId, fixture!.directMembershipId));

    expect(result.hasAccess).toBe(true);
    expect(count).toBeLessThanOrEqual(3);
  }, 30_000);

  it("grants a team-assigned member in the same three statements, so team access costs no extra round trip", async () => {
    const { result, count } = await measure("team-member", actor(fixture!, fixture!.teamUserId, fixture!.teamMembershipId));

    expect(result.hasAccess).toBe(true);
    expect(count).toBeLessThanOrEqual(3);
  }, 30_000);

  it("denies an unrelated org member in the same three statements, so a denial is no cheaper to detect than a grant", async () => {
    const { result, count } = await measure("denied", actor(fixture!, fixture!.deniedUserId, fixture!.deniedMembershipId));

    expect(result.hasAccess).toBe(false);
    expect(count).toBeLessThanOrEqual(3);
  }, 30_000);

  it("resolves the project manager without issuing either membership query, which is the one path that is genuinely cheaper", async () => {
    const owner = actor(fixture!, fixture!.ownerUserId, fixture!.ownerMembershipId);
    const { result, count } = await measure("manager", owner);

    expect(result.role).toBe("MANAGER");
    expect(count).toBeLessThan(3);
  }, 30_000);
});
