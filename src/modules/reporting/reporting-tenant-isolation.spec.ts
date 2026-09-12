jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
  runInNewTenantTransaction: <T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(db),
}));
jest.mock("../../common/tenant", () => ({
  ...jest.requireActual("../../common/tenant"),
  forEachOrg: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { forEachOrg } from "../../common/tenant";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import {
  crmReportDefinitions,
  crmReportRuns,
  crmReportScheduleRecipients,
  crmReportSchedules,
  organizations,
} from "../../db/schema";
import { sqlValues, tenantDb } from "../../test/tenant-recorder";
import { REPORTING_REGISTRY } from "./compiler/registry";
import { REPORTING_RUN } from "./reporting-source-access";
import { ReportSchedulesService } from "./report-schedules.service";
import { ReportingService } from "./reporting.service";

/**
 * Cross-tenant isolation for saved reports, their runs and their schedules.
 *
 * The attacker names the OWNER's report definition and schedule ids, and runs
 * an ad-hoc report of its own. Every fixture holds the owner's rows only, and
 * the double answers each statement by the equalities it bound — an unscoped
 * read hands the owner's row back — so each deny case asserts both the outcome
 * (404 / empty / nothing executed) and that the org bound in the statement is
 * the caller's. For a run, the tenant lives inside the compiled SQL, so the
 * executed statement's bound parameters are walked for the caller's org.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const DEALS_COUNT = { source: "deals", select: [{ kind: "aggregate", aggregate: "count" }], limit: 10 };

const OWNER_DEFINITION = {
  organizationId: OWNER_ORG,
  reportDefinitionId: "rd-owner",
  name: "Owner pipeline",
  description: null,
  sourceKey: "deals",
  queryDescription: DEALS_COUNT,
  createdByUserId: "usr-owner",
};
const OWNER_RUN = { organizationId: OWNER_ORG, reportRunId: "run-owner", reportDefinitionId: "rd-owner", rowCount: 1 };
const OWNER_SCHEDULE = {
  organizationId: OWNER_ORG,
  reportScheduleId: "rs-owner",
  reportDefinitionId: "rd-owner",
  cadence: "daily",
  hourOfDay: 9,
  dayOfWeek: 1,
  dayOfMonth: 1,
  enabled: true,
  nextRunAt: new Date("2026-01-01T09:00:00Z"),
  runCount: 3,
};

function store() {
  return tenantDb({
    fixtures: [
      { table: crmReportDefinitions, org: crmReportDefinitions.organizationId, rows: [OWNER_DEFINITION] },
      { table: crmReportRuns, org: crmReportRuns.organizationId, rows: [OWNER_RUN] },
      { table: crmReportSchedules, org: crmReportSchedules.organizationId, rows: [OWNER_SCHEDULE] },
      {
        table: crmReportScheduleRecipients,
        org: crmReportScheduleRecipients.organizationId,
        rows: [{ organizationId: OWNER_ORG, reportScheduleId: "rs-owner", email: "cfo@owner.test" }],
      },
      { table: organizations, org: organizations.id, rows: [{ id: OWNER_ORG, timezone: "UTC" }] },
    ],
  });
}

/**
 * Holds the reporting key and the deals source key, at scope `all`.
 *
 * `scopeFor` is what `authorize()` actually calls now — `assertMayRunSource`
 * and `requesterScope` route through it (the MCP report-ceiling fix), not
 * `resolveUserPermissions` directly. Kept alongside it because other specs in
 * this file exercise paths that still read the map form.
 */
function access() {
  const dealsKey = REPORTING_REGISTRY.get("deals")!.requiredPermission;
  const granted = new Map<string, string>([[REPORTING_RUN, "all"], [dealsKey, "all"]]);
  return {
    resolveUserPermissions: jest.fn(async () => granted),
    scopeFor: jest.fn(async (_user: unknown, key: string) => granted.get(key) ?? "none"),
  };
}

/**
 * A stand-in for `AuthContextFactory` — its lookups (module availability,
 * membership, MFA) are irrelevant here since this file's own `access()` mock
 * answers `scopeFor` directly rather than consulting them.
 */
function authContexts() {
  return {
    create: (actor: unknown) => ({
      actor,
      moduleAvailable: async () => ({ available: true }),
      membership: async () => ({ active: true, isOwner: false, role: "MEMBER", membershipId: "m1" }),
      mfa: async () => ({ satisfied: true }),
    }),
  };
}

const executed = (t: ReturnType<typeof store>) => t.statements.filter((s) => s.op === "execute");

describe("ReportingService — cross-tenant isolation", () => {
  it("deny: another org's report definition id is a 404", async () => {
    const t = store();

    await expect(new ReportingService(t.db, access() as never, authContexts() as never).getDefinition(ATTACKER_ORG, "rd-owner")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.orgBound(t.on(crmReportDefinitions, "select")[0], crmReportDefinitions.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: running another org's saved report executes nothing and records no run", async () => {
    const t = store();

    await expect(
      new ReportingService(t.db, access() as never, authContexts() as never).runDefinition(
        { orgId: ATTACKER_ORG, userId: "usr-attacker" } as never,
        "rd-owner",
        {} as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(executed(t)).toHaveLength(0);
    expect(t.on(crmReportRuns, "insert")).toHaveLength(0);
  });

  it("deny: the definition and run lists show the attacker none of another org's reports", async () => {
    const t = store();
    const service = new ReportingService(t.db, access() as never, authContexts() as never);

    expect(await service.listDefinitions(ATTACKER_ORG, { limit: 50, offset: 0 } as never)).toEqual([]);
    expect(await service.listRuns(ATTACKER_ORG, { limit: 50, offset: 0 } as never)).toEqual([]);
    expect(t.orgBound(t.on(crmReportDefinitions, "select")[0], crmReportDefinitions.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(crmReportRuns, "select")[0], crmReportRuns.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: deleting another org's report definition is a 404", async () => {
    const t = store();

    await expect(new ReportingService(t.db, access() as never, authContexts() as never).deleteDefinition(ATTACKER_ORG, "rd-owner")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.orgBound(t.on(crmReportDefinitions, "delete")[0], crmReportDefinitions.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: an ad-hoc run executes SQL bound to the caller's org only, and audits it there", async () => {
    const t = store();

    await new ReportingService(t.db, access() as never, authContexts() as never).runAdHoc(
      { orgId: ATTACKER_ORG, userId: "usr-attacker" } as never,
      DEALS_COUNT as never,
    );

    const [run] = executed(t);
    const bound = sqlValues(run!.args[0]);
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).not.toContain(OWNER_ORG);
    expect(t.inserted(crmReportRuns).map((row) => row.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org reads and runs its own saved report", async () => {
    const t = store();
    const service = new ReportingService(t.db, access() as never, authContexts() as never);

    expect(await service.getDefinition(OWNER_ORG, "rd-owner")).toMatchObject({ reportDefinitionId: "rd-owner" });
    await service.runDefinition({ orgId: OWNER_ORG, userId: "usr-owner" } as never, "rd-owner", {} as never);
    expect(sqlValues(executed(t)[0]!.args[0])).toContain(OWNER_ORG);
    expect((await service.listRuns(OWNER_ORG, { limit: 50, offset: 0 } as never)).length).toBe(1);
  });
});

describe("ReportSchedulesService — cross-tenant isolation", () => {
  function build(t: ReturnType<typeof store>) {
    return new ReportSchedulesService(t.db, new ReportingService(t.db, access() as never, authContexts() as never));
  }

  afterEach(() => jest.restoreAllMocks());

  it("deny: another org's schedule id is a 404 and none of its recipients are read", async () => {
    const t = store();

    await expect(build(t).get(ATTACKER_ORG, "rs-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(crmReportSchedules, "select")[0], crmReportSchedules.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.on(crmReportScheduleRecipients)).toHaveLength(0);
  });

  it("deny: list, update and remove never reach another org's schedule", async () => {
    const t = store();
    const service = build(t);

    expect(await service.list(ATTACKER_ORG)).toEqual([]);
    await expect(service.update(ATTACKER_ORG, "rs-owner", { enabled: false } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(ATTACKER_ORG, "rs-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.on(crmReportSchedules, "update")).toHaveLength(0);
    expect(t.orgBound(t.on(crmReportSchedules, "delete")[0], crmReportSchedules.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: a schedule cannot be attached to another org's report definition", async () => {
    const t = store();

    await expect(
      build(t).create(ATTACKER_ORG, "usr-attacker", {
        reportDefinitionId: "rd-owner",
        cadence: "daily",
        hourOfDay: 9,
        recipients: ["spy@attacker.test"],
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.on(crmReportSchedules, "insert")).toHaveLength(0);
    expect(t.on(crmReportScheduleRecipients, "insert")).toHaveLength(0);
  });

  it("deny: the due sweep claims each org's schedules only inside that org", async () => {
    const t = store();
    const emit = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined as never);
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        for (const orgId of [ATTACKER_ORG, OWNER_ORG]) await fn(t.db, orgId);
        return { succeeded: 2, failed: 0 };
      },
    );

    const result = await build(t).sweepDueSchedules();

    expect(result.claimed).toBe(1);
    const [attackerDue, ownerDue] = t.on(crmReportSchedules, "select");
    expect(t.orgBound(attackerDue, crmReportSchedules.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(ownerDue, crmReportSchedules.organizationId)).toEqual([OWNER_ORG]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toMatchObject({ organizationId: OWNER_ORG, aggregateId: "rs-owner" });
  });

  it("control: the owning org reads its schedule with its own recipients", async () => {
    const t = store();
    const service = build(t);

    expect(await service.get(OWNER_ORG, "rs-owner")).toMatchObject({
      reportScheduleId: "rs-owner",
      recipients: ["cfo@owner.test"],
    });
    expect((await service.list(OWNER_ORG)).map((row) => row.reportScheduleId)).toEqual(["rs-owner"]);
  });
});
