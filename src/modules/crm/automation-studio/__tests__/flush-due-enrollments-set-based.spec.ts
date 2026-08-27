import { Test, type TestingModule } from "@nestjs/testing";
import { CrmSequencesRunnerService } from "../crm-sequences-runner.service";
import { SequenceOutboundService } from "../sequence-outbound.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { CrmOutboundEmailService } from "../../consent/crm-outbound-email.service";
import type { SendTimeFacts } from "../../../autonomy/send-guardrails";

type StepRow = { id: number; sequenceId: number; stepType: string; sortOrder: number; config: Record<string, unknown>; waitHours: number };
type EnrollmentUpdateCall = { id: string; status: string; currentStep?: number };

/**
 * A Monday morning inside the outbound working window.
 *
 * Fixed rather than `new Date()`, and that is not tidiness. Ticket 17 put every
 * step through the send-time guardrails, one of which is the recipient's working
 * hours — so a suite using the real clock passes on a Tuesday afternoon and
 * fails on a Saturday, and whoever sees it fail will assume the code broke.
 */
const MONDAY_11AM = new Date("2026-03-02T11:00:00.000Z");
const ENROLLED = new Date("2026-02-20T09:00:00.000Z");

function makeThenableChain(data: unknown[]) {
  const chain: Record<string, unknown> = {
    then(resolve: (v: unknown[]) => unknown) {
      return Promise.resolve(data).then(resolve);
    },
    catch(reject: (e: unknown) => unknown) {
      return Promise.resolve(data).catch(reject);
    },
  };
  const passthrough = () => chain;
  for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin", "set", "groupBy", "onConflictDoNothing"]) {
    chain[m] = passthrough;
  }
  return chain;
}

/** A snapshot in which nothing is wrong, so the guardrails allow the send. */
const permissiveFacts = (): SendTimeFacts => ({
  now: MONDAY_11AM,
  outboundClass: "cold_outreach",
  consent: "UNKNOWN",
  consentExpiresAt: null,
  suppressed: false,
  classStopped: false,
  recentSendsToParty: [],
  partyTimezone: null,
  tenantTimezone: "Europe/London",
  repliedAt: null,
  draftedAt: ENROLLED,
  dealState: "open",
  deferralsSoFar: 0,
});

describe("CrmSequencesRunnerService.flushDueEnrollments() — set-based reads", () => {
  let service: CrmSequencesRunnerService;
  let mockEmail: { send: jest.Mock };
  let mockOutbound: {
    lastInboundFrom: jest.Mock;
    sendTimeFacts: jest.Mock;
    holdStep: jest.Mock;
    recordBlocked: jest.Mock;
  };
  const updateCalls: EnrollmentUpdateCall[] = [];

  const STEPS_SEQ1: StepRow[] = [
    { id: 10, sequenceId: 1, stepType: "email", sortOrder: 0, config: { to: "a@b.com", subject: "S", body: "<p>H</p>" }, waitHours: 24 },
    { id: 11, sequenceId: 1, stepType: "call_task", sortOrder: 1, config: { taskTitle: "Call", assigneeId: "u1" }, waitHours: 0 },
  ];

  /*
    Deal ids are numeric, because `deals.id` is a serial. The fixtures used to
    say "d1"; nothing noticed while the runner never looked a deal up, and the
    moment it did — to find the party the frequency cap is keyed on — a
    non-numeric id resolved to no party and the enrolment failed closed.
  */
  const ENROLLMENT_AT_STEP_0 = {
    id: "e1", orgId: "org1", sequenceId: 1, entityType: "deal", entityId: "1",
    currentStep: 0, status: "active", stopReason: null, createdAt: ENROLLED,
  };
  const ENROLLMENT_AT_LAST_STEP = {
    id: "e2", orgId: "org1", sequenceId: 1, entityType: "deal", entityId: "2",
    currentStep: 1, status: "active", stopReason: null, createdAt: ENROLLED,
  };
  const ENROLLMENT_CONVERTED_LEAD = {
    id: "e3", orgId: "org1", sequenceId: 2, entityType: "lead", entityId: "42",
    currentStep: 0, status: "active", stopReason: null, createdAt: ENROLLED,
  };
  const ENROLLMENT_NO_STEPS = {
    id: "e4", orgId: "org1", sequenceId: 3, entityType: "deal", entityId: "4",
    currentStep: 0, status: "active", stopReason: null, createdAt: ENROLLED,
  };

  const SEQUENCES = [
    { id: 1, stopOn: null, isActive: true },
    { id: 2, stopOn: { converted: true }, isActive: true },
    { id: 3, stopOn: null, isActive: true },
  ];

  const STEPS_ALL: StepRow[] = [...STEPS_SEQ1];

  const LEAD_PARTIES = [{ organizationId: "org1", leadId: 42, partyId: "party-42" }];
  const DEAL_PARTIES = [
    { orgId: "org1", id: 1, partyId: "party-1" },
    { orgId: "org1", id: 2, partyId: "party-2" },
    { orgId: "org1", id: 4, partyId: "party-4" },
  ];
  const CONVERTED_LEADS = [{ organizationId: "org1", leadId: 42 }];

  beforeEach(async () => {
    updateCalls.length = 0;
    mockEmail = { send: jest.fn().mockResolvedValue(undefined) };
    mockOutbound = {
      lastInboundFrom: jest.fn().mockResolvedValue(null),
      sendTimeFacts: jest.fn().mockResolvedValue(permissiveFacts()),
      holdStep: jest.fn().mockResolvedValue({ outboundMessageId: "m1", holdUntil: MONDAY_11AM }),
      recordBlocked: jest.fn().mockResolvedValue(undefined),
    };

    let selectIndex = 0;
    const selectResults = [
      [ENROLLMENT_AT_STEP_0, ENROLLMENT_AT_LAST_STEP, ENROLLMENT_CONVERTED_LEAD, ENROLLMENT_NO_STEPS],
      SEQUENCES,
      STEPS_ALL,
      LEAD_PARTIES,
      DEAL_PARTIES,
      CONVERTED_LEADS,
    ];

    const captureSet = (setArg: Record<string, unknown>) => {
      return {
        where: jest.fn().mockImplementation(() => {
          updateCalls.push({ id: "?", status: String(setArg["status"] ?? ""), currentStep: setArg["currentStep"] as number | undefined });
          return {
            then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
            catch: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r) }),
          };
        }),
      };
    };

    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        const data = selectResults[selectIndex++] ?? [];
        return makeThenableChain(data as unknown[]);
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((setArg: Record<string, unknown>) => captureSet(setArg)),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
          catch: () => {},
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmSequencesRunnerService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CrmOutboundEmailService, useValue: mockEmail },
        { provide: SequenceOutboundService, useValue: mockOutbound },
      ],
    }).compile();

    service = module.get(CrmSequencesRunnerService);
  });

  afterEach(() => jest.clearAllMocks());

  it("enrollment at step 0 (mid-sequence) → advanced; enrollment at last step → completed", async () => {
    const result = await service.flushDueEnrollments(MONDAY_11AM);

    expect(result.processed).toBe(4);
    expect(result.advanced).toBe(1);
    expect(result.stopped).toBe(3);

    const statuses = updateCalls.map((c) => c.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("stopped");
  });

  it("reads each collection once, in bulk, rather than per enrollment", async () => {
    /*
      What this suite is named for. Ticket 17 added two more reads — the party
      behind each enrolment, for the frequency cap — and both are set-based for
      the same reason the others are: a per-enrolment lookup here is two hundred
      round trips on every tick of a cron that serves every tenant.
    */
    const db = (service as unknown as { db: { select: jest.Mock } }).db;
    await service.flushDueEnrollments(MONDAY_11AM);
    expect(db.select).toHaveBeenCalledTimes(6);
  });

  it("sends a step through the held outbound path rather than straight to the mailer", async () => {
    /*
      The heart of ticket 17. The runner used to call `CrmOutboundEmailService.send`
      from `executeStep`, so a sequence message left immediately: no frequency
      cap, no working-hours check, and no window in which a person could stop it.
    */
    await service.flushDueEnrollments(MONDAY_11AM);

    expect(mockOutbound.holdStep).toHaveBeenCalledTimes(1);
    expect(mockEmail.send).not.toHaveBeenCalled();

    const held = mockOutbound.holdStep.mock.calls[0]![0] as Record<string, unknown>;
    expect(held["partyId"]).toBe("party-1");
    expect(held["subject"]).toBe("S");
  });

  it("takes the send-time snapshot at the tick, not from the enrollment", async () => {
    await service.flushDueEnrollments(MONDAY_11AM);
    const facts = mockOutbound.sendTimeFacts.mock.calls[0]![0] as Record<string, unknown>;
    expect(facts["now"]).toEqual(MONDAY_11AM);
    expect(facts["partyId"]).toBe("party-1");
    expect(facts["recipientEmail"]).toBe("a@b.com");
  });

  it("treats a party who has never written to us as cold outreach", async () => {
    /*
      The class is derived rather than declared, which is ticket 17's sixth
      criterion: a genuinely cold campaign labelled `follow_up` by whoever built
      the sequence would escape the cold track's domain-reputation guardrails,
      and nothing about such a label is checkable.
    */
    await service.flushDueEnrollments(MONDAY_11AM);
    const facts = mockOutbound.sendTimeFacts.mock.calls[0]![0] as Record<string, unknown>;
    expect(facts["outboundClass"]).toBe("cold_outreach");
  });

  it("exits the enrollment when the party has replied", async () => {
    /*
      The behaviour that was configurable, switched on, and inert: `stopOn.replied`
      was logged as unsupported and the next message went out anyway.
    */
    mockOutbound.sendTimeFacts.mockResolvedValue({
      ...permissiveFacts(),
      repliedAt: new Date("2026-03-01T10:00:00.000Z"),
    });

    const result = await service.flushDueEnrollments(MONDAY_11AM);

    expect(mockOutbound.holdStep).not.toHaveBeenCalled();
    expect(result.advanced).toBe(0);
    expect(updateCalls.some((c) => c.status === "stopped")).toBe(true);
  });

  it("records a step the guardrails refused instead of dropping it", async () => {
    // A refusal that leaves no row is indistinguishable from a step that never
    // ran, and the two need different answers when a customer goes quiet.
    mockOutbound.sendTimeFacts.mockResolvedValue({
      ...permissiveFacts(),
      recentSendsToParty: [new Date("2026-03-01T10:00:00.000Z")],
    });

    await service.flushDueEnrollments(MONDAY_11AM);

    expect(mockOutbound.holdStep).not.toHaveBeenCalled();
    expect(mockOutbound.recordBlocked).toHaveBeenCalledTimes(1);
    const blocked = mockOutbound.recordBlocked.mock.calls[0]![0] as Record<string, unknown>;
    expect(blocked["reason"]).toBe("frequency-cap");
  });

  it("converted lead enrollment → stopped", async () => {
    const result = await service.flushDueEnrollments(MONDAY_11AM);

    expect(updateCalls.filter((c) => c.status === "stopped").length).toBeGreaterThanOrEqual(1);
    expect(result.stopped).toBeGreaterThanOrEqual(1);
  });

  it("enrollment with no steps for its sequence → completed immediately", async () => {
    const result = await service.flushDueEnrollments(MONDAY_11AM);

    expect(updateCalls.filter((c) => c.status === "completed").length).toBeGreaterThanOrEqual(1);
    expect(result.stopped).toBeGreaterThanOrEqual(1);
  });

  it("no due enrollments → zero counts returned without touching update", async () => {
    const emptyDb = {
      select: jest.fn().mockImplementation(() => makeThenableChain([])),
      update: jest.fn(),
      insert: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmSequencesRunnerService,
        { provide: DRIZZLE, useValue: emptyDb },
        { provide: CrmOutboundEmailService, useValue: mockEmail },
        { provide: SequenceOutboundService, useValue: mockOutbound },
      ],
    }).compile();

    const svc = module.get(CrmSequencesRunnerService);
    const result = await svc.flushDueEnrollments(MONDAY_11AM);

    expect(result).toEqual({ processed: 0, advanced: 0, stopped: 0 });
    expect(emptyDb.update).not.toHaveBeenCalled();
  });
});

describe("CrmSequencesRunnerService — a converted lead stops without re-querying", () => {
  it("uses the pre-fetched convertedLeadKeys set, not a live DB call", async () => {
    const selectCalls: string[] = [];
    let idx = 0;

    const enrollments = [
      {
        id: "e1", orgId: "org1", sequenceId: 1, entityType: "lead", entityId: "99",
        currentStep: 0, status: "active", stopReason: null, createdAt: ENROLLED,
      },
    ];
    const sequences = [{ id: 1, stopOn: { converted: true }, isActive: true }];
    const steps: unknown[] = [];
    const leadParties = [{ organizationId: "org1", leadId: 99, partyId: "party-99" }];
    const convertedLeads = [{ organizationId: "org1", leadId: 99 }];
    // No deal enrolments here, so no deal lookup is issued: enrolments,
    // sequences, steps, lead parties, converted leads.
    const results = [enrollments, sequences, steps, leadParties, convertedLeads];

    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCalls.push(`select-${idx}`);
        const data = results[idx++] ?? [];
        return {
          from: function () { return this; },
          where: function () { return this; },
          limit: function () { return this; },
          orderBy: function () { return this; },
          innerJoin: function () { return this; },
          then(resolve: (v: unknown) => unknown) { return Promise.resolve(data).then(resolve); },
          catch() { return this; },
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
            catch: () => {},
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmSequencesRunnerService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CrmOutboundEmailService, useValue: { send: jest.fn() } },
        {
          provide: SequenceOutboundService,
          useValue: {
            lastInboundFrom: jest.fn().mockResolvedValue(null),
            sendTimeFacts: jest.fn().mockResolvedValue(permissiveFacts()),
            holdStep: jest.fn(),
            recordBlocked: jest.fn(),
          },
        },
      ],
    }).compile();

    const svc = module.get(CrmSequencesRunnerService);
    const result = await svc.flushDueEnrollments(MONDAY_11AM);

    expect(result.stopped).toBe(1);
    expect(result.advanced).toBe(0);
    expect(selectCalls).toHaveLength(5);
  });
});
