/**
 * `/hr/org` once rendered a "Total" above the Job Roles list that could read 1 while
 * the list said "No job roles found": the list is `hr_job_roles WHERE is_active`,
 * while the headcount aggregate joined `hr_job_roles` with no liveness predicate, so
 * an archived role stayed a named group. Both now go through `liveJobRolesOf`, and
 * this suite pins on a real catalog that the number of named role groups the
 * aggregate reports equals the number of roles the list returns — with the archived
 * role's people folded into the unassigned group rather than counted under a role
 * the catalog no longer shows.
 *
 *   ALLOW_DESTRUCTIVE_DB_TESTS=1 HR_PROBE_DATABASE_URL=postgres://…/streamline_test \
 *     npx jest --config ./jest-db.json --runInBand --forceExit hr-org-job-roles-count.db
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { Test } from "@nestjs/testing";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { OrgHierarchyService } from "../../../organization/hierarchy/org-hierarchy.service";
import { HrOrgCatalogService } from "../hr-org-catalog.service";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "hr-org-job-roles-count.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 1,
    ssl: local ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

const ORG_SCOPED_TABLES = ["hr_employments", "hr_people", "hr_job_roles"] as const;

describe("GET /hr/org/roles and the role headcount share one liveness predicate", () => {
  let sql: ReturnType<typeof connect>;
  let service: HrOrgCatalogService;
  let probe: ProbeOrg;
  let liveRoleId: number;
  let archivedRoleId: number;

  async function seedRole(name: string, isActive: boolean): Promise<number> {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO hr_job_roles (org_id, name, is_active)
      VALUES (${probe.orgId}, ${name}, ${isActive}) RETURNING id`;
    return row.id;
  }

  async function seedEmployment(tag: string, jobRoleId: number): Promise<void> {
    const [person] = await sql<{ id: number }[]>`
      INSERT INTO hr_people (org_id) VALUES (${probe.orgId}) RETURNING id`;
    await sql`
      INSERT INTO hr_employments
        (org_id, person_id, employee_number, lifecycle_status, job_role_id, is_primary)
      VALUES (${probe.orgId}, ${person.id}, ${`EMP-${tag}`}, 'ACTIVE', ${jobRoleId}, true)`;
  }

  async function namedRoleGroups() {
    const groups = await service.getHeadcount(probe.orgId, "role");
    return groups.filter((group) => group.groupId !== null);
  }

  beforeAll(async () => {
    sql = connect();
    const db: Db = drizzle(sql, { schema });
    const moduleRef = await Test.createTestingModule({
      providers: [
        HrOrgCatalogService,
        { provide: DRIZZLE, useValue: db },
        { provide: OrgHierarchyService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(HrOrgCatalogService);
    probe = await createProbeOrg(sql, "hr-org-job-roles-count");
    liveRoleId = await seedRole("Engineer", true);
    archivedRoleId = await seedRole("Legacy Engineer", false);
    await seedEmployment("live", liveRoleId);
    await seedEmployment("archived", archivedRoleId);
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    if (probe) await dropProbeOrg(sql, probe, ORG_SCOPED_TABLES);
    await sql.end({ timeout: 5 });
  }, 60_000);

  it("one live + one archived role: the list has one role and the headcount names exactly one", async () => {
    const roles = await service.listJobRoles(probe.orgId);
    const named = await namedRoleGroups();

    expect(roles.map((role) => role.id)).toEqual([liveRoleId]);
    expect(named).toHaveLength(roles.length);
    expect(named).toEqual([{ groupId: liveRoleId, groupName: "Engineer", headcount: 1 }]);
  });

  it("the archived role's people are folded into the unassigned group, not counted under a role the list hides", async () => {
    const groups = await service.getHeadcount(probe.orgId, "role");
    const unassigned = groups.find((group) => group.groupId === null);

    expect(groups.some((group) => group.groupId === archivedRoleId)).toBe(false);
    expect(unassigned).toEqual({ groupId: null, groupName: null, headcount: 1 });
  });

  it("zero live roles: the list is empty and the headcount names no role", async () => {
    await service.deleteJobRole(probe.orgId, liveRoleId);

    const roles = await service.listJobRoles(probe.orgId);
    const named = await namedRoleGroups();

    expect(roles).toEqual([]);
    expect(named).toEqual([]);
  });
});
