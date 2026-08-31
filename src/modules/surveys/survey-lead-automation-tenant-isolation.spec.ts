jest.mock("../party/party-identifiers", () => ({
  resolvePartyByIdentifier: jest.fn().mockResolvedValue(null),
}));

import { SurveyLeadAutomationService } from "./survey-lead-automation.service";
import type { Db } from "../../db/drizzle.module";
import type { LeadsService } from "../leads/leads.service";
import type { LeadsDetailService } from "../leads/leads-detail.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { TasksService } from "../tasks/tasks.service";

describe("SurveyLeadAutomationService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  function makeDeps(orgId: string) {
    const leadsService = {
      create: jest.fn().mockResolvedValue({ id: 1, orgId, name: "Respondent", assignedToId: null }),
      update: jest.fn().mockResolvedValue({}),
    } as unknown as LeadsService;
    const leadsDetail = {
      updateCustomData: jest.fn().mockResolvedValue({}),
    } as unknown as LeadsDetailService;
    const notifications = {
      create: jest.fn().mockResolvedValue({}),
    } as unknown as NotificationsService;
    const tasksService = { create: jest.fn().mockResolvedValue({}) } as unknown as TasksService;
    const db = {} as Db;
    return { leadsService, leadsDetail, notifications, tasksService, db };
  }

  it("creates a lead scoped to the survey's org, not a different org (isolation)", async () => {
    const { leadsService, leadsDetail, notifications, tasksService, db } = makeDeps(OWNER_ORG);
    const svc = new SurveyLeadAutomationService(db, leadsService, leadsDetail, notifications, tasksService);

    const survey = { id: 1, orgId: OWNER_ORG, title: "Q4 Survey", createdBy: "user-1", settings: {} } as never;
    const session = { id: 10, orgId: OWNER_ORG } as never;
    const answers = [{ answerValue: null, answerText: "alice@example.com", question: { variableName: "email" } }] as never;
    const rules = [{ id: 1, action: { type: "create_lead", scoreThreshold: null } }] as never;

    await svc.run(survey, session, answers, 50, rules);

    expect(leadsService.create).toHaveBeenCalledWith(OWNER_ORG, expect.anything(), expect.anything());
  });

  it("never creates a lead in a different org than the survey's org (isolation: org boundary)", async () => {
    const { leadsService, leadsDetail, notifications, tasksService, db } = makeDeps(ATTACKER_ORG);
    const svc = new SurveyLeadAutomationService(db, leadsService, leadsDetail, notifications, tasksService);

    const ownerSurvey = { id: 2, orgId: OWNER_ORG, title: "Owner Survey", createdBy: "user-1", settings: {} } as never;
    const session = { id: 11, orgId: OWNER_ORG } as never;
    const answers = [{ answerValue: null, answerText: "bob@example.com", question: { variableName: "email" } }] as never;
    const rules = [{ id: 2, action: { type: "create_lead", scoreThreshold: null } }] as never;

    await svc.run(ownerSurvey, session, answers, 80, rules);

    if (jest.mocked(leadsService.create).mock.calls.length > 0) {
      const callArgs = jest.mocked(leadsService.create).mock.calls[0] as [string, ...unknown[]];
      expect(callArgs[0]).toBe(OWNER_ORG);
      expect(callArgs[0]).not.toBe(ATTACKER_ORG);
    }
  });
});
