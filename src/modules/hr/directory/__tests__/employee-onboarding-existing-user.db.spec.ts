import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import * as schema from "../../../../db/schema";
import {
  emailOutbox,
  hrEmployments,
  hrPeople,
  magicLinkTokens,
  organizationMembers,
  users,
} from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { CacheService } from "../../../../common/cache/cache.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../../billing/core/seat-ledger.service";
import { MembershipAdmissionService } from "../../../organization/core/membership-admission.service";
import { WebhooksDispatchService } from "../../../webhooks/webhooks-dispatch.service";
import { EmailService } from "../../../email/email.service";
import { EmailOutboxService, NO_EMAIL_PROVIDER_REASON } from "../../../email/email-outbox.service";
import { EmailSuppressionService } from "../../../email/email-suppression.service";
import { EmailProviderService } from "../../../email/email.provider";
import type { EmailDispatcher, Provider } from "../../../email/email-provider-selection";
import { validateEnv } from "../../../../config/env.validation";
import { ReportingLineService } from "../../../directory/reporting-line.service";
import { HrAuditService } from "../../core/hr-audit.service";
import { PersonEmploymentSyncService } from "../../core/person-employment-sync.service";
import {
  EmployeeOnboardingService,
  alreadyMemberInviteReason,
} from "../employee-onboarding.service";
import type { OnboardEmployeeInput } from "../dto/hr-directory.schemas";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "employee-onboarding-existing-user.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: local ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

function actorFor(org: ProbeOrg): CurrentUserContext {
  return {
    userId: org.userId,
    orgId: org.orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "probe-session",
    tokenScopes: null,
    principal: humanSessionPrincipal(org.membershipId, true),
  };
}

function statusOf(error: unknown): number | null {
  return error instanceof HttpException ? error.getStatus() : null;
}

describe("POST /hr/employees/onboard against a real schema", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let otherOrg: ProbeOrg;
  let seatCappedOrg: ProbeOrg;
  let service: EmployeeOnboardingService;
  let activeProvider: Provider = "resend";
  const logCritical = jest.fn<Promise<void>, [{ action: string; targetId?: string | null }]>();
  const extraUserIds: string[] = [];
  let counter = 0;

  async function globalUser(label: string): Promise<{ userId: string; email: string }> {
    counter += 1;
    const userId = `${org.userId}-${label}-${counter}`;
    const email = `${userId}@synthetic.invalid`;
    extraUserIds.push(userId);
    await sql`INSERT INTO users (id, email, name, is_active) VALUES (${userId}, ${email}, ${label}, true)`;
    return { userId, email };
  }

  async function employIn(target: ProbeOrg, userId: string, employeeNumber: string): Promise<void> {
    await sql`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${userId}, ${target.orgId}, 'MEMBER', false, 'ACTIVE', now())`;
    const [person] = await sql<{ id: number }[]>`
      INSERT INTO hr_people (org_id, user_id) VALUES (${target.orgId}, ${userId}) RETURNING id`;
    await sql`
      INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, joining_date)
      VALUES (${target.orgId}, ${person.id}, ${employeeNumber}, 'ACTIVE', true, '2026-01-01')`;
  }

  function body(email: string, overrides: Partial<OnboardEmployeeInput> = {}): OnboardEmployeeInput {
    return {
      firstName: "Probe",
      lastName: "Joiner",
      email,
      designation: "Software developer",
      joiningDate: "2026-08-16",
      monthlySalary: 123000,
      taxId: "CPEPC8823M",
      bankDetails: { accountNumber: "0011223344", bankName: "Probe Bank", ifsc: "PROB0000001" },
      ...overrides,
    };
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "onboard-existing");
    otherOrg = await createProbeOrg(sql, "onboard-existing-other");
    seatCappedOrg = await createProbeOrg(sql, "onboard-existing-capped");
    await sql`
      INSERT INTO subscriptions (org_id, plan, status, current_period_end)
      VALUES (${org.orgId}, 'PROFESSIONAL', 'ACTIVE', now() + interval '30 days')`;
    const cache = new CacheService(null);
    const admission = new MembershipAdmissionService(
      new PlanLimitsService(db, cache, null),
      new SeatLedgerService(db),
    );
    const dispatcher: EmailDispatcher = {
      getEmailProvider: () => activeProvider,
      sendEmailOnceDirect: () => Promise.resolve(),
      dispatchEmail: () => Promise.resolve(),
    };
    const providerService = new EmailProviderService(
      validateEnv({
        DATABASE_URL: "postgres://user:pass@host/db",
        BACKEND_JWT_SECRET: "a".repeat(44),
        PORTAL_JWT_SECRET: "b".repeat(44),
        CORS_ORIGINS: "https://app.example.com",
        APP_URL: "https://app.example.com",
        ENCRYPTION_KEY: "c".repeat(32),
      }),
    );
    const email = new EmailService(
      new EmailOutboxService(db, new EmailSuppressionService(db), dispatcher),
      providerService,
    );
    service = new EmployeeOnboardingService(
      db,
      cache,
      { logCritical } as never,
      email,
      { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
      new WebhooksDispatchService(db),
      new PersonEmploymentSyncService(db, new HrAuditService(db)),
      { canManageOrganizationMembership: jest.fn().mockResolvedValue(true) } as never,
      admission,
      new ReportingLineService(db),
    );
  });

  afterAll(async () => {
    const orgScoped = [
      "hr_employee_sensitive_fields",
      "employee_salary_profile_components",
      "employee_salary_profiles",
      "hr_employments",
      "hr_people",
      "hr_audit_logs",
      "billing_seat_events",
      "org_unit_members",
      "subscriptions",
    ];
    for (const probe of [org, otherOrg, seatCappedOrg]) {
      if (!probe) continue;
      await sql`DELETE FROM email_outbox WHERE organization_id = ${probe.orgId}`;
      for (const table of orgScoped) await sql.unsafe(`DELETE FROM ${table} WHERE org_id = $1`, [probe.orgId]);
      await sql`DELETE FROM organization_people WHERE organization_id = ${probe.orgId}`;
      await dropProbeOrg(sql, probe);
    }
    for (const userId of extraUserIds) await sql`DELETE FROM users WHERE id = ${userId}`;
    if (sql) await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    activeProvider = "resend";
    logCritical.mockReset();
    logCritical.mockResolvedValue(undefined);
  });

  async function outboxRowsFor(email: string) {
    return db
      .select({ status: emailOutbox.status, subject: emailOutbox.subject, recipientUserId: emailOutbox.recipientUserId })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.organizationId, org.orgId), eq(emailOutbox.toEmail, email)))
      .limit(5);
  }

  async function tokensFor(userId: string) {
    return db
      .select({ id: magicLinkTokens.id, usedAt: magicLinkTokens.usedAt })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.userId, userId))
      .limit(5);
  }

  it("admits an account that exists globally but belongs to no organisation and tells them they were added", async () => {
    const { userId, email } = await globalUser("unaffiliated");

    const result = await service.onboardEmployee(actorFor(org), body(email));

    expect(result).toEqual({ success: true, userId, invite: { sent: true, reason: null } });
    expect(await outboxRowsFor(email)).toEqual([
      { status: "PENDING", subject: `You've been added to Probe ${org.orgId.replace("probe-org-", "")}`, recipientUserId: userId },
    ]);
    expect(await tokensFor(userId)).toEqual([{ id: expect.any(String), usedAt: null }]);
    const [member] = await db
      .select({ status: organizationMembers.status })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, org.orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    expect(member?.status).toBe("ACTIVE");
    const [employment] = await db
      .select({ status: hrEmployments.lifecycleStatus, designation: hrEmployments.designation })
      .from(hrEmployments)
      .innerJoin(hrPeople, eq(hrPeople.id, hrEmployments.personId))
      .where(and(eq(hrEmployments.orgId, org.orgId), eq(hrPeople.userId, userId)))
      .limit(1);
    expect(employment).toEqual({ status: "ONBOARDING", designation: "Software developer" });
    expect(logCritical).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hr.employee_onboarded", targetId: userId }),
    );
  });

  it("admits an account that is already an employee of another organisation", async () => {
    const { userId, email } = await globalUser("elsewhere");
    await employIn(otherOrg, userId, "EMP-ELSEWHERE");

    const result = await service.onboardEmployee(actorFor(org), body(email, { employeeId: "EMP-ELSEWHERE" }));

    expect(result).toMatchObject({ success: true, userId, invite: { sent: true, reason: null } });
    const rows = await db
      .select({ orgId: hrEmployments.orgId, employeeNumber: hrEmployments.employeeNumber })
      .from(hrEmployments)
      .innerJoin(hrPeople, eq(hrPeople.id, hrEmployments.personId))
      .where(eq(hrPeople.userId, userId))
      .limit(5);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.orgId).sort()).toEqual([org.orgId, otherOrg.orgId].sort());
  });

  it("answers 409 with a human message for an employee number another person already holds", async () => {
    const holder = await globalUser("holder");
    await service.onboardEmployee(actorFor(org), body(holder.email, { employeeId: "EMP-TAKEN" }));
    const { email } = await globalUser("second");

    const failure = await service
      .onboardEmployee(actorFor(org), body(email, { employeeId: "EMP-TAKEN" }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    expect(statusOf(failure)).toBe(409);
    expect(failure).toHaveProperty("message", expect.stringContaining("EMP-TAKEN"));
  });

  it("answers 409, never 500, for an employee number a soft-deleted employment of another person still holds", async () => {
    const former = await globalUser("former");
    await service.onboardEmployee(actorFor(org), body(former.email, { employeeId: "EMP-RETIRED" }));
    await db
      .update(hrEmployments)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrEmployments.orgId, org.orgId), eq(hrEmployments.employeeNumber, "EMP-RETIRED")));
    const { email } = await globalUser("reuser");

    const failure = await service
      .onboardEmployee(actorFor(org), body(email, { employeeId: "EMP-RETIRED" }))
      .catch((error: unknown) => error);

    expect(statusOf(failure)).toBe(409);
  });

  it("answers 409, never 500, when a member's earlier salary profile already starts on the joining date", async () => {
    const { userId, email } = await globalUser("rejoiner");
    await service.onboardEmployee(actorFor(org), body(email));
    const personIds = await db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, org.orgId), eq(hrPeople.userId, userId)))
      .limit(1);
    const personId = personIds[0]?.id;
    if (personId === undefined) throw new Error("fixture: person missing");
    await db.update(hrEmployments).set({ deletedAt: new Date() }).where(eq(hrEmployments.personId, personId));

    const failure = await service
      .onboardEmployee(actorFor(org), body(email, { attachToExistingMember: true }))
      .catch((error: unknown) => error);

    expect(statusOf(failure)).toBe(409);
    expect(failure).toHaveProperty("message", expect.stringContaining("2026-08-16"));
  });

  it("answers 402 with the plan's own message when the organisation has no seat left", async () => {
    for (let seat = 0; seat < 4; seat += 1) {
      const filler = await globalUser("filler");
      await sql`
        INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
        VALUES (${filler.userId}, ${seatCappedOrg.orgId}, 'MEMBER', false, 'ACTIVE', now())`;
    }
    const { email } = await globalUser("sixth");

    const failure = await service
      .onboardEmployee(actorFor(seatCappedOrg), body(email))
      .catch((error: unknown) => error);

    expect(statusOf(failure)).toBe(402);
    expect(failure).toHaveProperty("message", expect.stringContaining("plan allows 5 team members"));
  });

  it("refuses a suspended global account with 400 rather than admitting it", async () => {
    const { userId, email } = await globalUser("suspended");
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));

    const failure = await service.onboardEmployee(actorFor(org), body(email)).catch((error: unknown) => error);

    expect(statusOf(failure)).toBe(400);
  });

  it("mints a magic link for a brand-new account and queues the welcome email durably", async () => {
    counter += 1;
    const email = `${org.userId}-fresh-${counter}@synthetic.invalid`;

    const result = await service.onboardEmployee(actorFor(org), body(email));

    extraUserIds.push(result.userId);
    expect(result.invite).toEqual({ sent: true, reason: null });
    expect(await tokensFor(result.userId)).toEqual([{ id: expect.any(String), usedAt: null }]);
    expect(await outboxRowsFor(email)).toEqual([
      { status: "PENDING", subject: expect.stringContaining("account is ready"), recipientUserId: result.userId },
    ]);
  });

  it("reports the invite as not sent, retires the token and keeps a FAILED row when no provider is configured", async () => {
    activeProvider = "none";
    counter += 1;
    const email = `${org.userId}-unsendable-${counter}@synthetic.invalid`;

    const result = await service.onboardEmployee(actorFor(org), body(email));

    extraUserIds.push(result.userId);
    expect(result.invite).toEqual({ sent: false, reason: NO_EMAIL_PROVIDER_REASON });
    expect(await tokensFor(result.userId)).toEqual([{ id: expect.any(String), usedAt: expect.any(Date) }]);
    expect(await outboxRowsFor(email)).toEqual([
      { status: "FAILED", subject: expect.stringContaining("account is ready"), recipientUserId: result.userId },
    ]);
  });

  it("sends nothing when attaching employment to someone who is already a member, and says so", async () => {
    const { userId, email } = await globalUser("member");
    await sql`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${userId}, ${org.orgId}, 'MEMBER', false, 'ACTIVE', now())`;

    const result = await service.onboardEmployee(
      actorFor(org),
      body(email, { attachToExistingMember: true, monthlySalary: undefined }),
    );

    const [organisation] = await sql<{ name: string }[]>`SELECT name FROM organizations WHERE id = ${org.orgId}`;
    expect(result).toEqual({
      success: true,
      userId,
      invite: { sent: false, reason: alreadyMemberInviteReason(organisation.name) },
    });
    expect(await outboxRowsFor(email)).toEqual([]);
    expect(await tokensFor(userId)).toEqual([]);
  });

  describe("resendInvite", () => {
    it("mints a fresh token, queues the email again and audits it", async () => {
      const { userId, email } = await globalUser("resend");
      await service.onboardEmployee(actorFor(org), body(email, { monthlySalary: undefined }));
      logCritical.mockClear();

      const result = await service.resendInvite(actorFor(org), userId);

      expect(result).toEqual({ success: true, invite: { sent: true, reason: null } });
      expect(await tokensFor(userId)).toHaveLength(2);
      expect((await outboxRowsFor(email)).map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
      expect(logCritical).toHaveBeenCalledWith(
        expect.objectContaining({ action: "hr.employee_invite_resent", targetId: userId }),
      );
    });

    it("answers 404 for a member of another organisation and for an unknown id", async () => {
      const { userId } = await globalUser("foreign");
      await employIn(otherOrg, userId, "EMP-FOREIGN");

      await expect(service.resendInvite(actorFor(org), userId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resendInvite(actorFor(org), "no-such-user")).rejects.toBeInstanceOf(NotFoundException);
      expect(await tokensFor(userId)).toEqual([]);
    });
  });
});
