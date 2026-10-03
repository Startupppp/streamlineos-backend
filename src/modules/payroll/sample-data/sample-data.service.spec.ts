import { ConflictException } from "@nestjs/common";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { DirectoryService } from "../../directory/directory.service";
import type { ProfilesService } from "../runs/profiles.service";
import { PayrollSampleDataService, SAMPLE_EMAIL_DOMAIN, SAMPLE_TAG } from "./sample-data.service";

const dialect = new PgDialect();
const ORG = "org-caller";
const OTHER_ORG = "org-other";
const ACTOR = { userId: "user-1", membershipId: 7 };

type Deleted = { table: string; sql: string; params: unknown[] };

function build(statusRows: Array<Record<string, number>>, deleteError?: unknown) {
  const deletes: Deleted[] = [];
  const reads: Array<{ sql: string; params: unknown[] }> = [];
  let statusCall = 0;
  const db = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn((fields: Record<string, SQL>) => {
      for (const field of Object.values(fields)) reads.push(dialect.sqlToQuery(field));
      const row = statusRows[Math.min(statusCall, statusRows.length - 1)];
      statusCall += 1;
      const node = {
        from: jest.fn(() => node),
        where: jest.fn((where: SQL) => {
          reads.push(dialect.sqlToQuery(where));
          return Promise.resolve([row]);
        }),
      };
      return node;
    }),
    delete: jest.fn((table: PgTable) => ({
      where: jest.fn((where: SQL) => {
        const query = dialect.sqlToQuery(where);
        deletes.push({ table: getTableConfig(table).name, sql: query.sql, params: query.params });
        return deleteError ? Promise.reject(deleteError) : Promise.resolve();
      }),
    })),
  };
  let n = 0;
  const directory = {
    createPerson: jest.fn(async () => ({ organizationPersonId: `person-${++n}` })),
    createWorker: jest.fn(async (_org: string, _user: string, input: { organizationPersonId: string; isPayee?: boolean }) => ({
      workerId: `worker-of-${input.organizationPersonId}`,
    })),
    createEngagement: jest.fn(async () => ({})),
  };
  const profiles = { createProfileByWorker: jest.fn(async () => ({ profileId: 1 })) };
  const audit = { logCritical: jest.fn(async () => undefined) };
  const service = new PayrollSampleDataService(
    db as unknown as Db,
    directory as unknown as DirectoryService,
    profiles as unknown as ProfilesService,
    audit as unknown as AuditService,
  );
  return { service, db, directory, profiles, audit, deletes, reads };
}

const EMPTY = { people: 0, payees: 0, salaryProfiles: 0 };
const SEEDED = { people: 5, payees: 5, salaryProfiles: 3 };

describe("PayrollSampleDataService", () => {
  it("seeds five payable sample people, three with salary profiles, through the directory and profile services", async () => {
    const { service, directory, profiles, audit } = build([EMPTY, SEEDED]);

    const result = await service.seed(ORG, ACTOR, new Date("2026-10-03T00:00:00Z"));

    expect(result).toEqual({ present: true, ...SEEDED });
    expect(directory.createPerson).toHaveBeenCalledTimes(5);
    for (const [org, , input] of directory.createPerson.mock.calls as unknown as Array<[string, string, { firstName: string; workEmail: string }]>) {
      expect(org).toBe(ORG);
      expect(input.firstName.startsWith("Sample · ")).toBe(true);
      expect(input.workEmail.endsWith(`@${SAMPLE_EMAIL_DOMAIN}`)).toBe(true);
    }
    expect(directory.createWorker).toHaveBeenCalledTimes(5);
    expect(directory.createWorker.mock.calls.every(([org, , input]) => org === ORG && input.organizationPersonId.startsWith("person-") && input.isPayee === true)).toBe(true);
    expect(directory.createEngagement).toHaveBeenCalledTimes(5);
    expect(directory.createEngagement).toHaveBeenCalledWith(ORG, "user-1", 7, expect.objectContaining({ isPrimary: true, startsOn: "2026-10-01" }));
    expect(profiles.createProfileByWorker).toHaveBeenCalledTimes(3);
    for (const call of profiles.createProfileByWorker.mock.calls as unknown as Array<[string, string, string, { costCenter: string }]>) {
      expect(call[0]).toBe(ORG);
      expect(call[3].costCenter).toBe(SAMPLE_TAG);
    }
    expect(audit.logCritical).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.sample_data.seeded", orgId: ORG }));
  });

  it("a second seed is a no-op that returns the current counts", async () => {
    const { service, directory, profiles, audit } = build([SEEDED]);

    const result = await service.seed(ORG, ACTOR);

    expect(result).toEqual({ present: true, ...SEEDED });
    expect(directory.createPerson).not.toHaveBeenCalled();
    expect(profiles.createProfileByWorker).not.toHaveBeenCalled();
    expect(audit.logCritical).not.toHaveBeenCalled();
  });

  it("delete removes only tagged rows of the caller's org", async () => {
    const { service, deletes, audit } = build([SEEDED, EMPTY]);

    const result = await service.remove(ORG, ACTOR);

    expect(result).toEqual({ present: false, ...EMPTY });
    expect(deletes.map((d) => d.table)).toEqual([
      "employee_salary_profiles",
      "worker_engagements",
      "workers",
      "organization_people",
    ]);
    for (const d of deletes) {
      expect(d.params).toContain(ORG);
      expect(d.params).not.toContain(OTHER_ORG);
      expect(d.params).toContain(`%@${SAMPLE_EMAIL_DOMAIN}`);
      expect(d.params.filter((p) => typeof p === "string" && p.startsWith("org-")).every((p) => p === ORG)).toBe(true);
    }
    expect(deletes[0]?.params).toContain(SAMPLE_TAG);
    expect(audit.logCritical).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.sample_data.removed", orgId: ORG }));
  });

  it("status reads only the caller's org", async () => {
    const { service, reads } = build([SEEDED]);

    await expect(service.status(ORG)).resolves.toEqual({ present: true, ...SEEDED });
    const params = reads.flatMap((r) => r.params);
    expect(params).toContain(ORG);
    expect(params.filter((p) => typeof p === "string" && p.startsWith("org-")).every((p) => p === ORG)).toBe(true);
    expect(reads.some((r) => r.sql.includes("employee_salary_profiles") && r.params.includes(SAMPLE_TAG))).toBe(true);
  });

  it("delete with nothing seeded touches nothing", async () => {
    const { service, deletes } = build([EMPTY]);

    await service.remove(ORG, ACTOR);

    expect(deletes).toHaveLength(0);
  });

  it("refuses with 409 when sample people are referenced by records the tenant created", async () => {
    const fkError = Object.assign(new Error("fk"), { code: "23503" });
    const { service, audit } = build([SEEDED], fkError);

    await expect(service.remove(ORG, ACTOR)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.logCritical).not.toHaveBeenCalled();
  });
});
