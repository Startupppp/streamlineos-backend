import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { ApprovalAuthorityService } from "../approval-authority.service";
import { EmploymentFactsService } from "../employment-facts.service";
import { ReportingLineService } from "../reporting-line.service";
import { connectProbe, ReportingProbe } from "./reporting-probe";

jest.setTimeout(120_000);

class LeaveApprovers {
  readonly approvers = new Set<string>();

  async resolveUserPermissions(_orgId: string, userId: string): Promise<Map<string, DataScope>> {
    return new Map(this.approvers.has(userId) ? [["hr:leaves:approve", "own"]] : []);
  }

  async membersWithPermission(): Promise<Array<{ userId: string; membershipId: number }>> {
    return [];
  }
}

describe("approval routing reads only the current PRIMARY reporting line", () => {
  let sql: ReturnType<typeof connectProbe>;
  let probe: ReportingProbe;
  let access: LeaveApprovers;
  let approvals: ApprovalAuthorityService;

  beforeAll(async () => {
    sql = connectProbe("approval-routing-primary-only.db.spec.ts");
    probe = await ReportingProbe.create(sql, "rl-approval-routing");
    access = new LeaveApprovers();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: DRIZZLE, useValue: drizzle(sql, { schema }) },
        { provide: AccessService, useValue: access },
        EmploymentFactsService,
        ReportingLineService,
        ApprovalAuthorityService,
      ],
    }).compile();
    approvals = moduleRef.get(ApprovalAuthorityService);
  });

  afterAll(async () => {
    if (probe) await probe.drop();
    if (sql) await sql.end({ timeout: 5 });
  });

  it("routes to the primary manager even when a secondary manager could also approve", async () => {
    const primary = await probe.person("primary-manager");
    const secondary = await probe.person("secondary-manager");
    const employee = await probe.person("employee");
    await probe.line(employee, primary, "2026-01-01");
    await probe.line(employee, secondary, "2026-01-01", "infinity", "matrix");
    access.approvers.add(primary.userId);
    access.approvers.add(secondary.userId);

    const route = await approvals.resolve(probe.orgId, employee.userId, "leave");

    expect(route.rung).toBe("reporting_manager");
    expect(route.approver?.userId).toBe(primary.userId);
  });

  it("never falls back to a secondary manager when there is no primary one", async () => {
    const secondary = await probe.person("only-secondary");
    const employee = await probe.person("no-primary");
    await probe.line(employee, secondary, "2026-01-01", "infinity", "dotted");
    access.approvers.add(secondary.userId);

    const route = await approvals.resolve(probe.orgId, employee.userId, "leave");

    expect(route.skipped).toEqual(expect.arrayContaining([{ rung: "reporting_manager", userId: null, reason: "no-manager" }]));
    expect(route.approver?.userId).not.toBe(secondary.userId);
  });

  it("ignores a primary line that has ended or not yet begun", async () => {
    const past = await probe.person("past-manager");
    const future = await probe.person("future-manager");
    const employee = await probe.person("between");
    await probe.line(employee, past, "2025-01-01", "2025-12-31");
    await probe.line(employee, future, "2099-01-01");
    access.approvers.add(past.userId);
    access.approvers.add(future.userId);

    const route = await approvals.resolve(probe.orgId, employee.userId, "leave");

    expect(route.skipped).toEqual(expect.arrayContaining([{ rung: "reporting_manager", userId: null, reason: "no-manager" }]));
    expect([past.userId, future.userId]).not.toContain(route.approver?.userId);
  });
});
