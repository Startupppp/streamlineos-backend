import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import * as schema from "../../../../db/schema";
import { helpdeskQueues, helpdeskTickets, hrAuditLogs } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.types";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";
import { AccessService } from "../../../access/access.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { HrAuditService } from "../../core/hr-audit.service";
import { HrHelpdeskConfigService } from "../hr-helpdesk-config.service";
import { HrHelpdeskEscalationService } from "../hr-helpdesk-escalation.service";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "hr-helpdesk-escalation.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), { prepare: false, max: 2, ssl: local ? false : "require", connect_timeout: 30, onnotice: () => {} });
}

const HOUR = 3_600_000;

describe("employee support escalation sweep — real database", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let probe: ProbeOrg;
  let bystander: ProbeOrg;
  let leadUserId: string;
  let leadMembershipId: number;
  let service: HrHelpdeskEscalationService;
  const dispatch = { emit: jest.fn().mockResolvedValue({ outboxIds: [] }) };
  const now = new Date();

  const ticketIds: Record<string, number> = {};

  async function insertTicket(
    orgId: string,
    userId: string,
    label: string,
    values: Partial<typeof helpdeskTickets.$inferInsert>,
  ) {
    const [row] = await db
      .insert(helpdeskTickets)
      .values({
        orgId,
        userId,
        title: `${label} ${orgId}`,
        category: "it_access",
        queue: "IT",
        priority: "MEDIUM",
        status: "TODO",
        isConfidential: false,
        createdAt: new Date(now.getTime() - 48 * HOUR),
        updatedAt: new Date(now.getTime() - 48 * HOUR),
        ...values,
      })
      .returning({ id: helpdeskTickets.id });
    ticketIds[label] = row.id;
    return row.id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    probe = await createProbeOrg(sql, "support-escalation");
    bystander = await createProbeOrg(sql, "support-bystander");

    leadUserId = `${probe.userId}-lead`;
    await sql`INSERT INTO users (id, email, name, is_active) VALUES (${leadUserId}, ${`${leadUserId}@synthetic.invalid`}, ${"IT Lead"}, true)`;
    const [lead] = await sql<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${leadUserId}, ${probe.orgId}, 'MEMBER', false, 'ACTIVE', now())
      RETURNING id`;
    leadMembershipId = lead.id;

    await db.insert(helpdeskQueues).values({
      orgId: probe.orgId,
      queue: "IT",
      firstResponseHours: 4,
      resolutionHours: 24,
      escalationUserId: leadUserId,
      escalationMembershipId: leadMembershipId,
    });

    await insertTicket(probe.orgId, probe.userId, "resolution-overdue", {
      firstResponseDueAt: new Date(now.getTime() - 44 * HOUR),
      firstRespondedAt: new Date(now.getTime() - 40 * HOUR),
      slaDueAt: new Date(now.getTime() - 24 * HOUR),
      status: "IN_PROGRESS",
    });
    await insertTicket(probe.orgId, probe.userId, "first-response-overdue", {
      firstResponseDueAt: new Date(now.getTime() - 1 * HOUR),
      firstRespondedAt: null,
      slaDueAt: new Date(now.getTime() + 20 * HOUR),
    });
    await insertTicket(probe.orgId, probe.userId, "answered-in-time", {
      firstResponseDueAt: new Date(now.getTime() - 1 * HOUR),
      firstRespondedAt: new Date(now.getTime() - 2 * HOUR),
      slaDueAt: new Date(now.getTime() + 20 * HOUR),
    });
    await insertTicket(probe.orgId, probe.userId, "resolved-late-but-done", {
      firstResponseDueAt: new Date(now.getTime() - 44 * HOUR),
      slaDueAt: new Date(now.getTime() - 24 * HOUR),
      status: "DONE",
      resolvedAt: new Date(now.getTime() - 20 * HOUR),
    });
    await insertTicket(probe.orgId, probe.userId, "already-escalated", {
      firstResponseDueAt: new Date(now.getTime() - 44 * HOUR),
      slaDueAt: new Date(now.getTime() - 24 * HOUR),
      escalationLevel: 1,
      escalatedAt: new Date(now.getTime() - 23 * HOUR),
      assigneeId: leadUserId,
      assigneeMembershipId: leadMembershipId,
    });
    await insertTicket(probe.orgId, probe.userId, "admin-queue-no-target", {
      queue: "ADMIN",
      category: "facilities",
      firstResponseDueAt: new Date(now.getTime() - 40 * HOUR),
      slaDueAt: new Date(now.getTime() - 1 * HOUR),
    });
    await insertTicket(bystander.orgId, bystander.userId, "foreign-overdue", {
      firstResponseDueAt: new Date(now.getTime() - 44 * HOUR),
      slaDueAt: new Date(now.getTime() - 24 * HOUR),
    });

    const module = await Test.createTestingModule({
      providers: [
        HrHelpdeskEscalationService,
        HrHelpdeskConfigService,
        HrAuditService,
        { provide: DRIZZLE, useValue: db },
        { provide: AccessService, useValue: {} },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    service = module.get(HrHelpdeskEscalationService);
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      if (bystander) await dropProbeOrg(sql, bystander, ["hr_audit_logs", "helpdesk_tickets", "helpdesk_queues"]);
      if (probe) {
        await dropProbeOrg(sql, probe, ["hr_audit_logs", "helpdesk_tickets", "helpdesk_queues"]);
        await sql`DELETE FROM users WHERE id = ${leadUserId}`;
      }
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  async function ticket(label: string) {
    const [row] = await db
      .select({
        escalationLevel: helpdeskTickets.escalationLevel,
        escalatedAt: helpdeskTickets.escalatedAt,
        assigneeId: helpdeskTickets.assigneeId,
        assigneeMembershipId: helpdeskTickets.assigneeMembershipId,
      })
      .from(helpdeskTickets)
      .where(eq(helpdeskTickets.id, ticketIds[label]));
    return row;
  }

  it("escalates exactly the overdue open tickets of the tenant, once, to the queue's target or the administrators", async () => {
    const admins = { membersWithPermission: jest.fn().mockResolvedValue([{ userId: probe.userId, membershipId: probe.membershipId }]) };

    const outcome = await service.sweepOrg(db, probe.orgId, now, admins);

    expect(outcome).toEqual({ escalated: 3, unassignable: 0 });

    expect(await ticket("resolution-overdue")).toMatchObject({ escalationLevel: 1, assigneeId: leadUserId, assigneeMembershipId: leadMembershipId });
    expect(await ticket("first-response-overdue")).toMatchObject({ escalationLevel: 1, assigneeId: leadUserId });
    expect(await ticket("admin-queue-no-target")).toMatchObject({ escalationLevel: 1, assigneeId: probe.userId, assigneeMembershipId: probe.membershipId });
    expect((await ticket("resolution-overdue")).escalatedAt).not.toBeNull();

    expect(await ticket("answered-in-time")).toMatchObject({ escalationLevel: 0, assigneeId: null });
    expect(await ticket("resolved-late-but-done")).toMatchObject({ escalationLevel: 0 });
    expect(await ticket("already-escalated")).toMatchObject({ escalationLevel: 1 });
    expect(await ticket("foreign-overdue")).toMatchObject({ escalationLevel: 0, assigneeId: null });

    const audits = await db
      .select({ entityId: hrAuditLogs.entityId, action: hrAuditLogs.action })
      .from(hrAuditLogs)
      .where(and(eq(hrAuditLogs.orgId, probe.orgId), eq(hrAuditLogs.action, "helpdesk.ticket.escalated")));
    expect(audits.map((row) => Number(row.entityId)).sort()).toEqual(
      [ticketIds["resolution-overdue"], ticketIds["first-response-overdue"], ticketIds["admin-queue-no-target"]].sort(),
    );

    expect(dispatch.emit).toHaveBeenCalledTimes(3);
    expect(dispatch.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "hr.helpdesk.ticket_escalated",
        targetUserIds: [leadUserId],
        entityId: String(ticketIds["resolution-overdue"]),
        variables: expect.objectContaining({ breach: "resolution", queue: "IT" }),
      }),
    );
    expect(dispatch.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: String(ticketIds["first-response-overdue"]),
        variables: expect.objectContaining({ breach: "first_response" }),
      }),
    );
  });

  it("a second tick finds nothing left to escalate", async () => {
    const admins = { membersWithPermission: jest.fn().mockResolvedValue([]) };

    const outcome = await service.sweepOrg(db, probe.orgId, now, admins);

    expect(outcome).toEqual({ escalated: 0, unassignable: 0 });
    expect(admins.membersWithPermission).not.toHaveBeenCalled();
  });
});
