import { SurveyLeadAutomationService, scoreToPriority, extractAnswerMap } from "./survey-lead-automation.service";
import { isAssigneeNotMember } from "../leads/leads.service";
import { resolvePartyByIdentifier } from "../party/party-identifiers";
import type { PartyRow } from "../party/party-legacy-mirror";
import type { AutomationRule } from "./survey-automation.service";

jest.mock("../leads/leads.service", () => ({
  ...jest.requireActual("../leads/leads.service"),
}));

/*
 * The identifier resolver is stubbed, not reimplemented: it owns normalisation
 * and the soft-delete release, both of which have their own tests, and what
 * matters here is only whether the automation found a lead or created one.
 */
jest.mock("../party/party-identifiers", () => ({
  resolvePartyByIdentifier: jest.fn(),
}));

const resolveIdentifier = jest.mocked(resolvePartyByIdentifier);

describe("scoreToPriority", () => {
  it("returns COLD below 40", () => {
    expect(scoreToPriority(0)).toBe("COLD");
    expect(scoreToPriority(39)).toBe("COLD");
  });

  it("returns WARM between 40 and 69", () => {
    expect(scoreToPriority(40)).toBe("WARM");
    expect(scoreToPriority(69)).toBe("WARM");
  });

  it("returns HOT at 70 and above", () => {
    expect(scoreToPriority(70)).toBe("HOT");
    expect(scoreToPriority(100)).toBe("HOT");
  });
});

describe("extractAnswerMap", () => {
  it("keys answers by the question's variableName", () => {
    const map = extractAnswerMap([
      { answerText: "jane@acme.com", answerValue: null, question: { variableName: "email" } },
      { answerText: null, answerValue: "Acme Inc", question: { variableName: "company" } },
    ]);
    expect(map).toEqual({ email: "jane@acme.com", company: "Acme Inc" });
  });

  it("skips answers whose question has no variableName", () => {
    const map = extractAnswerMap([
      { answerText: "some free text", answerValue: null, question: { variableName: null } },
      { answerText: null, answerValue: null, question: null },
    ]);
    expect(map).toEqual({});
  });

  it("prefers answerText over a non-string answerValue", () => {
    const map = extractAnswerMap([
      { answerText: "$10k+", answerValue: { choiceId: 3 }, question: { variableName: "budget" } },
    ]);
    expect(map).toEqual({ budget: "$10k+" });
  });
});

/** Only the columns `LEAD_MIRROR.derive` and `leadViewFrom` actually read. */
function partyOf(overrides: Partial<PartyRow>): PartyRow {
  return {
    partyId: "party_7",
    organizationId: "org_1",
    name: "Jane",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  } as PartyRow;
}

function buildService(overrides: { existingLead?: { id: number; party: Partial<PartyRow> } } = {}) {
  const existing = overrides.existingLead;
  resolveIdentifier.mockReset();
  resolveIdentifier.mockResolvedValue(existing ? partyOf(existing.party).partyId : null);

  // The lead read is `select(...).from(lead_party_map).innerJoin(business_parties)
  // .where(...).orderBy(...).limit(1)`, so the mock is that chain and nothing else.
  const limit = jest
    .fn()
    .mockResolvedValue(existing ? [{ leadId: existing.id, party: partyOf(existing.party) }] : []);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const db = { select: jest.fn().mockReturnValue({ from }) };
  const leadsService = {
    create: jest.fn().mockResolvedValue({ id: 42, name: "Survey respondent", assignedToId: null }),
    update: jest.fn().mockResolvedValue({}),
  };
  const leadsDetail = { updateCustomData: jest.fn().mockResolvedValue({}) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const tasks = { create: jest.fn().mockResolvedValue({}) };

  const service = new SurveyLeadAutomationService(
    db as never,
    leadsService as never,
    leadsDetail as never,
    notifications as never,
    tasks as never,
  );
  return { service, db, leadsService, leadsDetail, notifications, tasks };
}

const surveyBase = { id: 1, orgId: "org_1", title: "Lead Qualification", createdBy: "user_1" };
const survey = surveyBase as never;
const session = { id: 5, orgId: "org_1" };

function createLeadRule(overrides: Partial<AutomationRule["action"]> = {}): AutomationRule {
  return { id: "rule_1", eventType: "survey.response.submitted", action: { type: "create_lead", ...overrides } };
}

describe("SurveyLeadAutomationService.run", () => {
  it("does not create a lead when the score is below the rule's threshold", async () => {
    const { service, leadsService } = buildService();
    const rule = createLeadRule({ scoreThreshold: 50 });
    await service.run(survey, session, [{ answerText: "a@b.com", answerValue: null, question: { variableName: "email" } }], 10, [rule]);
    expect(leadsService.create).not.toHaveBeenCalled();
  });

  it("creates a lead with a HOT priority when the score clears the threshold", async () => {
    const { service, leadsService, leadsDetail } = buildService();
    const rule = createLeadRule({ scoreThreshold: 50 });
    await service.run(
      survey,
      session,
      [{ answerText: "a@b.com", answerValue: null, question: { variableName: "email" } }],
      100,
      [rule],
    );
    expect(leadsService.create).toHaveBeenCalledTimes(1);
    const [orgId, userId, input] = leadsService.create.mock.calls[0];
    expect(orgId).toBe("org_1");
    expect(userId).toBe("user_1");
    expect(input.email).toBe("a@b.com");
    expect(input.priority).toBe("HOT");
    expect(leadsDetail.updateCustomData).toHaveBeenCalledWith(
      "org_1",
      42,
      expect.objectContaining({ customData: expect.objectContaining({ surveyId: 1, surveySessionId: 5, surveyScore: 100 }) }),
    );
  });

  it("skips lead creation when there is no email or phone answer", async () => {
    const { service, leadsService } = buildService();
    const rule = createLeadRule();
    await service.run(survey, session, [{ answerText: "Acme", answerValue: null, question: { variableName: "company" } }], 100, [rule]);
    expect(leadsService.create).not.toHaveBeenCalled();
  });

  it("updates and dedupes against an existing lead matched by email instead of creating a duplicate", async () => {
    const existingLead = {
      id: 7,
      party: { notes: "Prior note", customFields: { foo: "bar" } },
    };
    const { service, leadsService } = buildService({ existingLead });
    const rule = createLeadRule();
    await service.run(
      survey,
      session,
      [{ answerText: "dup@acme.com", answerValue: null, question: { variableName: "email" } }],
      100,
      [rule],
    );
    expect(leadsService.create).not.toHaveBeenCalled();
    expect(leadsService.update).toHaveBeenCalledWith(
      "org_1",
      "user_1",
      7,
      expect.objectContaining({ priority: "HOT", notes: expect.stringContaining("Prior note") }),
    );
  });

  it("skips entirely when the survey has no creator to act as the audit actor", async () => {
    const { service, leadsService } = buildService();
    const orphanSurvey = { ...surveyBase, createdBy: null } as never;
    const rule = createLeadRule();
    await service.run(
      orphanSurvey,
      session,
      [{ answerText: "a@b.com", answerValue: null, question: { variableName: "email" } }],
      100,
      [rule],
    );
    expect(leadsService.create).not.toHaveBeenCalled();
  });

  it("notifies the survey owner for a notify_owner rule once the threshold is met", async () => {
    const { service, notifications } = buildService();
    const rule: AutomationRule = {
      id: "rule_2",
      eventType: "survey.response.submitted",
      action: { type: "notify_owner", scoreThreshold: 50 },
    };
    await service.run(survey, session, [], 80, [rule]);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "user_1", category: "CRM" }),
    );
  });

  it("creates a follow-up task only when the created lead has an assigned owner", async () => {
    const { service, leadsService, tasks } = buildService();
    leadsService.create.mockResolvedValueOnce({ id: 9, name: "Jane", assignedToId: "user_9" });
    const rule = createLeadRule({ config: { createFollowUpTask: true } });
    await service.run(survey, session, [{ answerText: "a@b.com", answerValue: null, question: { variableName: "email" } }], 100, [rule]);
    expect(tasks.create).toHaveBeenCalledWith(
      "org_1",
      "user_1",
      expect.objectContaining({ entityType: "LEAD", entityId: 9, assigneeId: "user_9" }),
    );
  });

  it("does not create a follow-up task when the lead has no assignee", async () => {
    const { service, tasks } = buildService();
    const rule = createLeadRule({ config: { createFollowUpTask: true } });
    await service.run(survey, session, [{ answerText: "a@b.com", answerValue: null, question: { variableName: "email" } }], 100, [rule]);
    expect(tasks.create).not.toHaveBeenCalled();
  });
});

describe("isAssigneeNotMember (sanity re-export check)", () => {
  it("recognizes the assignee-not-member error shape", () => {
    expect(isAssigneeNotMember({ error: "assignee_not_member" })).toBe(true);
    expect(isAssigneeNotMember({ id: 1 })).toBe(false);
  });
});
