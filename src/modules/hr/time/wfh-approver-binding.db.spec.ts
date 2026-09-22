import { BadRequestException, NotFoundException } from "@nestjs/common";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../test/helpers/probe-org";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import type { AccessService } from "../../access/access.service";
import type { ApprovalAuthorityService } from "../../directory/approval-authority.service";
import type { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { WfhService } from "./wfh.service";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "wfh-approver-binding.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), { prepare: false, max: 2, ssl: local ? false : "require", connect_timeout: 30, onnotice: () => {} });
}

interface Member {
  userId: string;
  membershipId: number;
  user: CurrentUserContext;
}

describe("WfhService binds decisions to the routed approver", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let service: WfhService;
  const scopes = new Map<string, DataScope>();
  const resolveRoute = jest.fn();
  const extraUserIds: string[] = [];
  let counter = 0;

  async function addMember(label: string): Promise<Member> {
    counter += 1;
    const userId = `${org.userId}-${label}-${counter}`;
    extraUserIds.push(userId);
    await sql`INSERT INTO users (id, email, name, is_active) VALUES (${userId}, ${`${userId}@synthetic.invalid`}, ${label}, true)`;
    const [member] = await sql<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${userId}, ${org.orgId}, 'MEMBER', false, 'ACTIVE', now())
      RETURNING id`;
    await sql`
      INSERT INTO organization_people (organization_person_id, organization_id, organization_membership_id, user_id, first_name, last_name, display_name)
      VALUES (${`${userId}-person`}, ${org.orgId}, ${member.id}, ${userId}, ${label}, 'Probe', ${label})`;
    return {
      userId,
      membershipId: member.id,
      user: {
        userId,
        orgId: org.orgId,
        role: "MEMBER",
        isOrgOwner: false,
        sessionId: `session-${counter}`,
        tokenScopes: null,
        principal: humanSessionPrincipal(member.id, false),
      },
    };
  }

  async function pendingRequest(employee: Member, approver: Member | null): Promise<number> {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO wfh_requests (org_id, user_id, user_membership_id, date, reason, status, approver_id, approver_membership_id)
      VALUES (${org.orgId}, ${employee.userId}, ${employee.membershipId}, '2026-10-01', 'Focus day', 'PENDING', ${approver?.userId ?? null}, ${approver?.membershipId ?? null})
      RETURNING id`;
    return row.id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "wfh-binding");
    const access = {
      resolveUserPermissions: async (_orgId: string, userId: string) => {
        const scope = scopes.get(userId);
        return new Map(scope ? [["hr:attendance:manage", scope]] : []);
      },
    } as unknown as AccessService;
    const approvals = { resolve: resolveRoute } as unknown as ApprovalAuthorityService;
    service = new WfhService(db, access, approvals, null as unknown as HrPolicyEvaluationService);
  });

  afterAll(async () => {
    if (org) {
      await sql`DELETE FROM wfh_requests WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM organization_people WHERE organization_id = ${org.orgId}`;
      await dropProbeOrg(sql, org);
    }
    for (const userId of extraUserIds) await sql`DELETE FROM users WHERE id = ${userId}`;
    if (sql) await sql.end({ timeout: 5 });
  });

  it("derives the approver from the approval authority instead of the request body", async () => {
    const employee = await addMember("employee");
    const manager = await addMember("manager");
    resolveRoute.mockResolvedValueOnce({
      rung: "reporting_manager",
      approver: { userId: manager.userId, membershipId: manager.membershipId, name: "manager", email: "m@x", designation: null },
      explanation: "manager approves as reporting manager.",
    });

    await service.create(org.orgId, employee.userId, { date: "2099-01-05", reason: "Focus" });

    const [row] = await sql<{ approver_id: string; approver_membership_id: number }[]>`
      SELECT approver_id, approver_membership_id FROM wfh_requests WHERE org_id = ${org.orgId} AND user_id = ${employee.userId}`;
    expect(row).toEqual({ approver_id: manager.userId, approver_membership_id: manager.membershipId });
    expect(resolveRoute).toHaveBeenCalledWith(org.orgId, employee.userId, "wfh");
  });

  it("refuses to file a request nobody can own", async () => {
    const employee = await addMember("orphan");
    resolveRoute.mockResolvedValueOnce({ rung: null, approver: null, explanation: "Nobody can approve this work-from-home request." });

    await expect(service.create(org.orgId, employee.userId, { date: "2099-01-06" })).rejects.toMatchObject({ status: 409 });
  });

  it("lets the routed approver decide at own scope, and hides the request from another own-scoped holder", async () => {
    const employee = await addMember("employee");
    const manager = await addMember("manager");
    const otherManager = await addMember("other-manager");
    scopes.set(manager.userId, "own");
    scopes.set(otherManager.userId, "own");
    const requestId = await pendingRequest(employee, manager);

    await expect(service.pending(otherManager.user)).resolves.toEqual([]);
    await expect(service.update(otherManager.user, requestId, { status: "APPROVED" })).rejects.toBeInstanceOf(NotFoundException);

    await expect(service.pending(manager.user)).resolves.toEqual([expect.objectContaining({ id: requestId })]);
    await expect(service.update(manager.user, requestId, { status: "APPROVED" })).resolves.toEqual({ success: true });
    const [row] = await sql<{ status: string; approver_id: string }[]>`SELECT status, approver_id FROM wfh_requests WHERE id = ${requestId}`;
    expect(row).toEqual({ status: "APPROVED", approver_id: manager.userId });
  });

  it("lets an unrestricted attendance manager decide a request routed to someone else, but never the employee their own", async () => {
    const employee = await addMember("employee");
    const manager = await addMember("manager");
    const hr = await addMember("hr");
    scopes.set(hr.userId, "all");
    scopes.set(employee.userId, "all");
    const requestId = await pendingRequest(employee, manager);

    await expect(service.update(employee.user, requestId, { status: "APPROVED" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update(hr.user, requestId, { status: "REJECTED", rejectionReason: "Team day" })).resolves.toEqual({ success: true });
    const [row] = await sql<{ status: string; approver_id: string; rejection_reason: string }[]>`
      SELECT status, approver_id, rejection_reason FROM wfh_requests WHERE id = ${requestId}`;
    expect(row).toEqual({ status: "REJECTED", approver_id: hr.userId, rejection_reason: "Team day" });
  });

  it("answers nothing to someone without the attendance key", async () => {
    const employee = await addMember("employee");
    const bystander = await addMember("bystander");
    const requestId = await pendingRequest(employee, null);

    await expect(service.pending(bystander.user)).resolves.toEqual([]);
    await expect(service.update(bystander.user, requestId, { status: "APPROVED" })).rejects.toBeInstanceOf(NotFoundException);
  });
});
