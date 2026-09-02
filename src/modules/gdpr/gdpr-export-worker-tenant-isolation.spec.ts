jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { countExportRows, drainExportPages, GENERIC_GDPR_EXPORT_EXCLUDED_SOURCES, GdprExportWorkerService, REQUIRED_GDPR_EXPORT_SOURCES } from "./gdpr-export-worker.service";
import { GdprExportService } from "./gdpr-export.service";
import { StorageService } from "../storage/storage.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import {
  agentTokens,
  feedbackRequests,
  hrWorkAuthorizations,
  signRecipients,
  timesheets,
} from "../../db/schema";
import {
  fetchSubjectScopedRows,
  fetchMembershipScopedRows,
  fetchEmploymentScopedRows,
} from "./gdpr-export-fetchers-generic";
import {
  fetchAiChatConversations,
  fetchAiChatMessages,
  fetchAiFeedback,
  fetchAiActionProposals,
  fetchAiJobs,
  fetchAiUsageLogs,
} from "./gdpr-export-fetchers-ai";
import { fetchAttendanceRegularizations } from "./gdpr-export-fetchers-hr";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...((record as { params?: unknown[] }).params ? sqlValues((record as { params: unknown[] }).params, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  let selectCount = 0;
  const makeWhereResult = (rows: unknown[]) => {
    const limitFn = jest.fn().mockResolvedValue(rows);
    const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
    return {
      orderBy: orderByFn,
      limit: limitFn,
      then: (
        onFulfilled: (v: unknown[]) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
  };
  const db = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockImplementation(() => {
      const rows = selectCount++ === 0
        ? [{ userId: "user-subj", email: "subject@example.invalid", name: null }]
        : [];
      return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeWhereResult(rows);
        }),
      }),
      };
    }),
  } as unknown as Db;
  return { db, allWhereArgs };
}

function makeServices(orgId: string) {
  const fakeJob = {
    id: 99,
    orgId,
    subjectUserId: "user-subj",
    createdAt: new Date("2026-01-01"),
  };
  const mockJobs = {
    claim: jest.fn().mockResolvedValue(fakeJob),
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  };
  const mockStorage = {
    isConfigured: jest.fn().mockReturnValue(true),
    uploadFile: jest.fn().mockResolvedValue({ key: "k", size: 10 }),
  };
  return { mockJobs, mockStorage };
}

describe("GdprExportWorkerService — cross-tenant isolation", () => {
  const origEnv = process.env.GDPR_EXPORT_WORKER_ENABLED;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.GDPR_EXPORT_WORKER_ENABLED = "false";
  });

  afterEach(() => {
    process.env.GDPR_EXPORT_WORKER_ENABLED = origEnv;
  });

  it("scopes every fetch WHERE to the attacker org only (cross-tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const { mockJobs, mockStorage } = makeServices(ATTACKER_ORG);

    (forEachOrg as jest.Mock).mockImplementation(
      async (
        _db: unknown,
        _label: unknown,
        cb: (tx: unknown, orgId: string) => Promise<void>,
      ) => {
        await cb(undefined, ATTACKER_ORG);
      },
    );

    const module = await Test.createTestingModule({
      providers: [
        GdprExportWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: GdprExportService, useValue: mockJobs },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    const svc = module.get(GdprExportWorkerService);

    svc.wake();
    await flushPromises();

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap((w) => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
    expect(allVals).not.toContain(OWNER_ORG);
  });

  it("scopes every fetch WHERE to the owner org only (same-tenant control — proves bite)", async () => {
    const { db, allWhereArgs } = makeDb();
    const { mockJobs, mockStorage } = makeServices(OWNER_ORG);

    (forEachOrg as jest.Mock).mockImplementation(
      async (
        _db: unknown,
        _label: unknown,
        cb: (tx: unknown, orgId: string) => Promise<void>,
      ) => {
        await cb(undefined, OWNER_ORG);
      },
    );

    const module = await Test.createTestingModule({
      providers: [
        GdprExportWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: GdprExportService, useValue: mockJobs },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    const svc = module.get(GdprExportWorkerService);

    svc.wake();
    await flushPromises();

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap((w) => sqlValues(w));
    expect(allVals).toContain(OWNER_ORG);
    expect(allVals).not.toContain(ATTACKER_ORG);
  });
});

describe("GdprExportWorkerService — storage not configured (G2)", () => {
  it("throws from wake() when storage is not configured, so the outbox event is not silently acknowledged", async () => {
    const { db } = makeDb();
    const { mockJobs } = makeServices(OWNER_ORG);
    const unconfiguredStorage = {
      isConfigured: jest.fn().mockReturnValue(false),
      uploadFile: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        GdprExportWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: GdprExportService, useValue: mockJobs },
        { provide: StorageService, useValue: unconfiguredStorage },
      ],
    }).compile();
    const svc = module.get(GdprExportWorkerService);

    expect(() => svc.wake()).toThrow("GDPR_EXPORT_STORAGE_NOT_CONFIGURED");
  });

  it("does not throw from wake() when storage is configured", async () => {
    const { db } = makeDb();
    const { mockJobs, mockStorage } = makeServices(OWNER_ORG);

    (forEachOrg as jest.Mock).mockResolvedValue({ organizations: 0 });

    const module = await Test.createTestingModule({
      providers: [
        GdprExportWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: GdprExportService, useValue: mockJobs },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    const svc = module.get(GdprExportWorkerService);

    expect(() => svc.wake()).not.toThrow();
  });
});

describe("drainExportPages", () => {
  it("resumes after the batch boundary and never truncates an available section", async () => {
    const first = Array.from({ length: 200 }, (_, index) => ({ id: index + 1 }));
    const second = Array.from({ length: 4_801 }, (_, index) => ({ id: index + 201 }));
    const calls: Array<number | undefined> = [];
    const result = await drainExportPages<number, { id: number }>(async (afterId) => {
      calls.push(afterId);
      if (afterId === undefined) return first;
      if (afterId === 200) return second;
      return [];
    });

    expect(result.rows).toHaveLength(5_001);
    expect(result.truncated).toBe(false);
    expect(calls).toEqual([undefined, 200, 5_001]);
  });

  it("resumes UUID-keyed sections with a stable string cursor", async () => {
    const calls: Array<string | undefined> = [];
    const result = await drainExportPages<string, { id: string }>(async (afterId) => {
      calls.push(afterId);
      if (afterId === undefined) return [{ id: "00000000-0000-0000-0000-000000000001" }];
      return [];
    });

    expect(result.rows).toHaveLength(1);
    expect(calls).toEqual([undefined]);
  });

  it("fails instead of looping when a page cursor does not advance", async () => {
    const page = Array.from({ length: 200 }, () => ({ id: 1 }));
    await expect(
      drainExportPages<number, { id: number }>(async (afterId) =>
        afterId === undefined ? page : page,
      ),
    ).rejects.toThrow("GDPR export cursor did not advance");
  });
});

describe("GDPR export source coverage", () => {
  it("keeps actor/recipient and credential-bearing records out of the generic adapter", () => {
    expect(GENERIC_GDPR_EXPORT_EXCLUDED_SOURCES).toEqual(expect.arrayContaining([
      "announcement_reads",
      "agent_tokens",
      "notification_digest_runs",
      "notification_suppression_rules",
      "onboarding_analytics_events",
      "onboarding_flow_sessions",
      "push_subscriptions",
      "user_integration_connections",
      "user_tour_progress",
    ]));
    for (const source of GENERIC_GDPR_EXPORT_EXCLUDED_SOURCES) {
      expect(REQUIRED_GDPR_EXPORT_SOURCES).not.toContain(source);
    }
  });

  it("includes effective-dated reporting-line history", () => {
    expect(REQUIRED_GDPR_EXPORT_SOURCES).toContain("hr_reporting_lines");
  });

  it("includes subject-owned attendance regularization requests", () => {
    expect(REQUIRED_GDPR_EXPORT_SOURCES).toContain("hr_attendance_regularizations");
  });

  it("includes subject-owned AI chat conversations and messages", () => {
    expect(REQUIRED_GDPR_EXPORT_SOURCES).toEqual(expect.arrayContaining([
      "ai_chat_conversations",
      "ai_chat_messages",
      "ai_feedback",
      "ai_action_proposals",
      "ai_jobs",
      "ai_usage_logs",
    ]));
  });

  it("registers the first-party subject tables discovered by the schema audit", () => {
    expect(REQUIRED_GDPR_EXPORT_SOURCES).toEqual(expect.arrayContaining([
      "attendance",
      "leave_requests",
      "performance_reviews",
      "hr_benefit_enrollments",
      "payroll_inputs",
      "payroll_run_employees",
      "notification_consent_events",
    ]));
  });

  it("registers all newly audited direct-subject sources", () => {
    expect(REQUIRED_GDPR_EXPORT_SOURCES).toEqual(expect.arrayContaining([
      "hr_accommodation_requests",
      "hr_access_provisioning",
      "hr_badge_awards",
      "hr_community_members",
      "hr_emergency_responses",
      "hr_mood_checkins",
      "hr_payroll_input_snapshots",
      "hr_payroll_adjustments",
      "hr_poll_votes",
      "hr_reward_points_ledger",
      "goals",
      "employee_skills",
      "assessment_attempts",
      "onboarding_tasks",
      "resignations",
      "terminations",
      "alumni_profiles",
      "background_verifications",
      "certifications",
      "performance_improvement_plans",
    ]));
  });

  it("includes catalogue and schema sources with verified subject ownership paths", () => {
    expect(REQUIRED_GDPR_EXPORT_SOURCES).toEqual(expect.arrayContaining([
      "ai_credit_reservations",
      "ai_credit_transactions",
      "biometric_logs",
      "event_attendees",
      "kb_chat_conversations",
      "kb_chat_messages",
      "meeting_attendees",
      "meeting_standup_entries",
      "project_members",
      "sign_recipients",
      "timer_sessions",
      "timesheet_exceptions",
      "timesheet_periods",
      "timesheet_rates",
      "timesheets",
      "hr_contracts",
      "hr_effective_dated_changes",
      "hr_employee_sensitive_fields",
      "hr_employment_history",
      "hr_probation_reviews",
      "hr_work_authorizations",
    ]));
  });

  it("counts AI chat rows in export metadata", () => {
    expect(countExportRows(
      { rows: [{ id: 1 }] },
      { rows: [{ id: 2 }, { id: 3 }] },
    )).toBe(3);
  });
});

describe("generic subject-scoped adapter", () => {
  it("uses tenant, subject, and cursor predicates while excluding credential columns", async () => {
    const whereArgs: unknown[] = [];
    const limit = jest.fn().mockResolvedValue([{ id: 11, userId: "user-subj" }]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((condition: unknown) => {
      whereArgs.push(condition);
      return { orderBy, limit };
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    await fetchSubjectScopedRows(db, agentTokens, agentTokens.userId, "org-owner", "user-subj", 10);

    const values = whereArgs.flatMap((condition) => sqlValues(condition));
    expect(values).toEqual(expect.arrayContaining(["org-owner", "user-subj", 10]));
    expect(db.select).toHaveBeenCalledWith(expect.not.objectContaining({ auth: expect.anything() }));
    expect(limit).toHaveBeenCalledWith(200);
  });

  it("does not project reviewer identities from subject-owned rows", async () => {
    const limit = jest.fn().mockResolvedValue([{ id: 11, subjectUserId: "user-subj" }]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy, limit });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    await fetchSubjectScopedRows(db, feedbackRequests, feedbackRequests.subjectUserId, "org-owner", "user-subj", 10);

    const selected = (db.select as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(selected).not.toHaveProperty("reviewerUserId");
    expect(selected).not.toHaveProperty("reviewerMembershipId");
  });
});

describe("membership and employment subject adapters", () => {
  it("uses a tenant membership join, subject predicate, cursor, and credential redaction", async () => {
    const whereArgs: unknown[] = [];
    const limit = jest.fn().mockResolvedValue([{ id: 12, membershipId: 4 }]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((condition: unknown) => {
      whereArgs.push(condition);
      return { orderBy };
    });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ innerJoin }),
      }),
    } as unknown as Db;

    await fetchMembershipScopedRows(
      db,
      signRecipients,
      signRecipients.userMembershipId,
      "org-owner",
      "user-subj",
      11,
    );

    const values = whereArgs.flatMap((condition) => sqlValues(condition));
    expect(values).toEqual(expect.arrayContaining(["org-owner", "user-subj", 11]));
    const selected = (db.select as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(selected).not.toHaveProperty("accessCodeHash");
    expect(selected).not.toHaveProperty("otpCodeHash");
    expect(selected).not.toHaveProperty("signingTokenHash");
    expect(innerJoin).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(200);
  });

  it("uses tenant-scoped employment and person joins for employee-owned records", async () => {
    const whereArgs: unknown[] = [];
    const limit = jest.fn().mockResolvedValue([{ id: 13, employmentId: 8 }]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((condition: unknown) => {
      whereArgs.push(condition);
      return { orderBy };
    });
    const secondInnerJoin = jest.fn().mockReturnValue({ where });
    const firstInnerJoin = jest.fn().mockReturnValue({ innerJoin: secondInnerJoin });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ innerJoin: firstInnerJoin }),
      }),
    } as unknown as Db;

    await fetchEmploymentScopedRows(
      db,
      hrWorkAuthorizations,
      hrWorkAuthorizations.employmentId,
      "org-owner",
      "user-subj",
      12,
    );

    const values = whereArgs.flatMap((condition) => sqlValues(condition));
    expect(values).toEqual(expect.arrayContaining(["org-owner", "user-subj", 12]));
    expect(firstInnerJoin).toHaveBeenCalledTimes(1);
    expect(secondInnerJoin).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(200);
  });

  it("keeps the timesheet membership path distinct from approver identities", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where }),
        }),
      }),
    } as unknown as Db;

    await fetchMembershipScopedRows(
      db,
      timesheets,
      timesheets.userMembershipId,
      "org-owner",
      "user-subj",
      3,
    );

    const selected = (db.select as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(selected).not.toHaveProperty("approvedByMembershipId");
    expect(selected).not.toHaveProperty("lockedByMembershipId");
  });
});

describe("GDPR AI subject adapters", () => {
  function makeAdapterDb(rows: unknown[]) {
    const whereArgs: unknown[] = [];
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((condition: unknown) => {
      whereArgs.push(condition);
      return { orderBy, limit };
    });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) };
    return { db: db as unknown as Db, whereArgs, limit };
  }

  it("fetches conversations with tenant, subject, and resumable cursor predicates", async () => {
    const { db, whereArgs, limit } = makeAdapterDb([{ id: 8, title: "HR chat" }]);

    const rows = await fetchAiChatConversations(db, "org-owner", "user-subj", 7);

    expect(rows).toEqual([{ id: 8, title: "HR chat" }]);
    expect(limit).toHaveBeenCalledWith(200);
    const values = whereArgs.flatMap((condition) => sqlValues(condition));
    expect(values).toContain("org-owner");
    expect(values).toContain("user-subj");
    expect(values).toContain(7);
    expect(values).not.toContain("org-attacker");
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("fetches messages with tenant, subject, and resumable cursor predicates", async () => {
    const { db, whereArgs, limit } = makeAdapterDb([{ id: 11, content: "private prompt" }]);

    const rows = await fetchAiChatMessages(db, "org-owner", "user-subj", 10);

    expect(rows).toEqual([{ id: 11, content: "private prompt" }]);
    expect(limit).toHaveBeenCalledWith(200);
    const values = whereArgs.flatMap((condition) => sqlValues(condition));
    expect(values).toContain("org-owner");
    expect(values).toContain("user-subj");
    expect(values).toContain(10);
    expect(values).not.toContain("org-attacker");
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["feedback", fetchAiFeedback] as const,
    ["action proposals", fetchAiActionProposals] as const,
    ["jobs", fetchAiJobs] as const,
    ["usage logs", fetchAiUsageLogs] as const,
  ])("fetches AI %s with tenant, subject, and resumable cursor predicates", async (_label, fetchFn) => {
    const { db, whereArgs, limit } = makeAdapterDb([{ id: 12 }]);

    const rows = await fetchFn(db, "org-owner", "user-subj", 11);

    expect(rows).toEqual([{ id: 12 }]);
    expect(limit).toHaveBeenCalledWith(200);
    const values = whereArgs.flatMap((condition) => sqlValues(condition));
    expect(values).toContain("org-owner");
    expect(values).toContain("user-subj");
    expect(values).toContain(11);
    expect(values).not.toContain("org-attacker");
  });
});

describe("GDPR attendance regularization adapter", () => {
  it("uses tenant, subject, and cursor predicates without exporting reviewer actor fields", async () => {
    const whereArgs: unknown[] = [];
    const limit = jest.fn().mockResolvedValue([{ id: 8, userId: "user-subj", status: "PENDING" }]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((condition: unknown) => {
      whereArgs.push(condition);
      return { orderBy, limit };
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where }),
      }),
    } as unknown as Db;

    const rows = await fetchAttendanceRegularizations(db, "org-owner", "user-subj", 7);

    expect(rows).toEqual([{ id: 8, userId: "user-subj", status: "PENDING" }]);
    expect(limit).toHaveBeenCalledWith(200);
    const values = whereArgs.flatMap((condition) => sqlValues(condition));
    expect(values).toEqual(expect.arrayContaining(["org-owner", "user-subj", 7]));
    expect(db.select).toHaveBeenCalledWith(expect.not.objectContaining({
      approvedBy: expect.anything(),
      rejectedBy: expect.anything(),
      approvedByMembershipId: expect.anything(),
      rejectedByMembershipId: expect.anything(),
    }));
  });
});
