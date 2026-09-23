import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReportingLineService } from "./reporting-line.service";

interface CandidateRow {
  membershipStatus: string;
  isOwner: boolean;
  userActive: boolean;
  employmentId: number | null;
  lifecycleStatus: string | null;
}

function dbReturning(rows: CandidateRow[]): unknown {
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "limit"])
    chain[method] = () => chain;
  return chain;
}

function serviceFor(rows: CandidateRow[]): ReportingLineService {
  return new ReportingLineService(dbReturning(rows) as never);
}

const ORG = "org-1";
const FOUNDER = "founder-1";

function owner(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    membershipStatus: "ACTIVE",
    isOwner: true,
    userActive: true,
    employmentId: null,
    lifecycleStatus: null,
    ...overrides,
  };
}

describe("ReportingLineService.checkApprover", () => {
  it("clears the org owner who was never hired as an employee, because an India SMB founder signs up before anyone is on payroll", async () => {
    const result = await serviceFor([owner()]).checkApprover(ORG, FOUNDER);

    expect(result).toEqual({ ok: true, managerEmploymentId: null });
  });

  it("still refuses a non-owner with no employment record, so approval authority is not handed to any member", async () => {
    const result = await serviceFor([owner({ isOwner: false })]).checkApprover(ORG, FOUNDER);

    expect(result).toEqual({
      ok: false,
      reason: "manager-has-no-employment",
      message: "The selected manager has no employment record, so they cannot own approvals.",
    });
  });

  it("returns the real employment id when the owner is also an employee, so the assignment path keeps its foreign key", async () => {
    const result = await serviceFor([
      owner({ employmentId: 42, lifecycleStatus: "ACTIVE" }),
    ]).checkApprover(ORG, FOUNDER);

    expect(result).toEqual({ ok: true, managerEmploymentId: 42 });
  });

  it("refuses an owner whose membership is no longer active, because ownership does not survive removal", async () => {
    const result = await serviceFor([owner({ membershipStatus: "REMOVED" })]).checkApprover(ORG, FOUNDER);

    expect(result).toMatchObject({ ok: false, reason: "manager-not-in-organization" });
  });

  it("refuses an owner whose user account is deactivated, because ownership does not survive deactivation", async () => {
    const result = await serviceFor([owner({ userActive: false })]).checkApprover(ORG, FOUNDER);

    expect(result).toMatchObject({ ok: false, reason: "manager-inactive" });
  });

  it("refuses an owner who has exited, because the employment they do have disqualifies them", async () => {
    const result = await serviceFor([
      owner({ employmentId: 7, lifecycleStatus: "EXITED" }),
    ]).checkApprover(ORG, FOUNDER);

    expect(result).toMatchObject({ ok: false, reason: "manager-exited" });
  });

  it("refuses a candidate with no membership row at all", async () => {
    const result = await serviceFor([]).checkApprover(ORG, FOUNDER);

    expect(result).toMatchObject({ ok: false, reason: "manager-not-in-organization" });
  });
});

describe("ReportingLineService.checkManager", () => {
  it("keeps refusing the employment-less owner, because hr_reporting_lines.manager_employment_id cannot be null", async () => {
    const result = await serviceFor([owner()]).checkManager(ORG, FOUNDER);

    expect(result).toMatchObject({ ok: false, reason: "manager-has-no-employment" });
  });

  it("still clears a manager who does hold a live employment record", async () => {
    const result = await serviceFor([
      owner({ isOwner: false, employmentId: 9, lifecycleStatus: "ACTIVE" }),
    ]).checkManager(ORG, FOUNDER);

    expect(result).toEqual({ ok: true, managerEmploymentId: 9 });
  });
});

describe("approval routing", () => {
  const source = readFileSync(join(__dirname, "approval-authority.service.ts"), "utf8");

  it("resolves an approver through checkApprover, not the stricter assignment check", () => {
    expect(source).toContain("this.reportingLines.checkApprover(");
    expect(source).not.toContain("this.reportingLines.checkManager(");
  });
});
