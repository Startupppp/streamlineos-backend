import {
  DEFAULT_CATEGORY_QUEUE,
  DEFAULT_QUEUE_SLA,
  HELPDESK_CATEGORIES,
  SUPPORT_QUEUES,
  canReadTicket,
  canWorkTicket,
  defaultConfidentiality,
  memberQueues,
  queuePermissionKey,
  resolveQueue,
  selectEscalationTarget,
  slaBreach,
  stampSla,
  type SupportActor,
} from "../support-queues";

describe("support queues — routing table", () => {
  it("maps every category to a queue so no request can be created without a destination", () => {
    for (const category of HELPDESK_CATEGORIES) {
      expect(SUPPORT_QUEUES).toContain(DEFAULT_CATEGORY_QUEUE[category]);
    }
  });

  it("routes each of the five queues from at least one default category", () => {
    const reached = new Set(Object.values(DEFAULT_CATEGORY_QUEUE));
    expect([...reached].sort()).toEqual([...SUPPORT_QUEUES].sort());
  });

  it("an org override wins over the default mapping", () => {
    expect(resolveQueue("it_access", null)).toBe("IT");
    expect(resolveQueue("it_access", "ADMIN")).toBe("ADMIN");
  });

  it("HR and Legal queues are confidential by default, the others are not", () => {
    expect(defaultConfidentiality("HR")).toBe(true);
    expect(defaultConfidentiality("LEGAL")).toBe(true);
    expect(defaultConfidentiality("IT")).toBe(false);
    expect(defaultConfidentiality("FINANCE")).toBe(false);
    expect(defaultConfidentiality("ADMIN")).toBe(false);
  });

  it("derives a lowercase queue permission key under the hr:helpdesk resource so it implies the agent view key", () => {
    expect(queuePermissionKey("FINANCE")).toBe("hr:helpdesk:queue-finance");
  });
});

describe("support queues — SLA stamping", () => {
  it("stamps first-response and resolution due from the queue's hours", () => {
    const createdAt = new Date("2026-09-21T09:00:00Z");
    const stamped = stampSla(createdAt, { firstResponseHours: 4, resolutionHours: 24 });
    expect(stamped.firstResponseDueAt.toISOString()).toBe("2026-09-21T13:00:00.000Z");
    expect(stamped.slaDueAt.toISOString()).toBe("2026-09-22T09:00:00.000Z");
  });

  it("every default SLA has a first response shorter than its resolution window", () => {
    for (const queue of SUPPORT_QUEUES) {
      const sla = DEFAULT_QUEUE_SLA[queue];
      expect(sla.firstResponseHours).toBeGreaterThan(0);
      expect(sla.resolutionHours).toBeGreaterThan(sla.firstResponseHours);
    }
  });

  it("reports a first-response breach only while nobody has responded", () => {
    const now = new Date("2026-09-21T15:00:00Z");
    const due = new Date("2026-09-21T13:00:00Z");
    expect(slaBreach({ firstResponseDueAt: due, firstRespondedAt: null, slaDueAt: null }, now)).toBe("first_response");
    expect(slaBreach({ firstResponseDueAt: due, firstRespondedAt: new Date("2026-09-21T12:00:00Z"), slaDueAt: null }, now)).toBeNull();
  });

  it("a resolution breach outranks a first-response breach", () => {
    const now = new Date("2026-09-23T15:00:00Z");
    expect(
      slaBreach(
        { firstResponseDueAt: new Date("2026-09-21T13:00:00Z"), firstRespondedAt: null, slaDueAt: new Date("2026-09-22T09:00:00Z") },
        now,
      ),
    ).toBe("resolution");
  });

  it("nothing is breached before either due stamp", () => {
    const now = new Date("2026-09-21T10:00:00Z");
    expect(
      slaBreach(
        { firstResponseDueAt: new Date("2026-09-21T13:00:00Z"), firstRespondedAt: null, slaDueAt: new Date("2026-09-22T09:00:00Z") },
        now,
      ),
    ).toBeNull();
  });
});

describe("support queues — escalation target selection", () => {
  const admins = [{ userId: "admin-a" }, { userId: "admin-b" }];

  it("prefers the queue's configured escalation target", () => {
    expect(selectEscalationTarget("lead-1", admins, "agent-1")).toBe("lead-1");
  });

  it("falls back to a support administrator who is not already the assignee", () => {
    expect(selectEscalationTarget(null, admins, "admin-a")).toBe("admin-b");
  });

  it("falls back to the only administrator even when they already hold the ticket", () => {
    expect(selectEscalationTarget(null, [{ userId: "admin-a" }], "admin-a")).toBe("admin-a");
  });

  it("returns null when the org has neither a target nor an administrator", () => {
    expect(selectEscalationTarget(null, [], null)).toBeNull();
  });
});

describe("support queues — confidentiality predicate", () => {
  const member = (queues: SupportActor["queues"], isAdmin = false): SupportActor => ({
    orgId: "org-1",
    userId: "agent-1",
    membershipId: 10,
    isAdmin,
    queues,
  });

  it("a confidential ticket is readable by the requester and by that queue's members only", () => {
    const ticket = { userId: "employee-1", queue: "HR" as const, isConfidential: true };
    expect(canReadTicket(member(new Set(["HR"])), ticket)).toBe(true);
    expect(canReadTicket(member(new Set(["IT"])), ticket)).toBe(false);
    expect(canReadTicket(member(new Set()), ticket)).toBe(false);
    expect(canReadTicket({ ...member(new Set()), userId: "employee-1" }, ticket)).toBe(true);
  });

  it("a non-confidential ticket is readable by any agent-surface holder but workable only by queue members", () => {
    const ticket = { userId: "employee-1", queue: "IT" as const, isConfidential: false };
    expect(canReadTicket(member(new Set(["HR"])), ticket)).toBe(true);
    expect(canWorkTicket(member(new Set(["HR"])), ticket)).toBe(false);
    expect(canWorkTicket(member(new Set(["IT"])), ticket)).toBe(true);
  });

  it("a support administrator is a member of every queue", () => {
    expect([...memberQueues(new Set(), true)].sort()).toEqual([...SUPPORT_QUEUES].sort());
    expect(canWorkTicket(member(new Set(), true), { queue: "LEGAL" })).toBe(true);
  });

  it("queue membership is read from the per-queue keys and nothing else", () => {
    const held = new Set(["hr:helpdesk:view", "hr:helpdesk:queue-finance", "hr:helpdesk:queue-legal"]);
    expect([...memberQueues(held, false)].sort()).toEqual(["FINANCE", "LEGAL"]);
  });
});
