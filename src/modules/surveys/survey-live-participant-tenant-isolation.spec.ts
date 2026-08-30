import { SurveyLiveParticipantService } from "./survey-live-participant.service";
import type { Db } from "../../db/drizzle.module";

describe("SurveyLiveParticipantService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("inserts the response session with the session's orgId, not a different org (isolation)", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 42, orgId: OWNER_ORG }]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = {
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
    const svc = new SurveyLiveParticipantService(db);

    const ownerSession = {
      id: 1,
      orgId: OWNER_ORG,
      surveyId: 5,
      versionId: 2,
      status: "active",
      currentQuestionId: null,
    } as never;

    const result = await svc.join(ownerSession, { name: "Alice" });

    expect(result.participantToken).toBeDefined();
    const insertedValues = (values.mock.calls[0]?.[0] as { orgId?: string } | undefined);
    expect(insertedValues?.orgId).toBe(OWNER_ORG);
  });

  it("does not leak a different org's session data (isolation — attacker session inserts only attacker org)", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 99, orgId: ATTACKER_ORG }]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = {
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
    const svc = new SurveyLiveParticipantService(db);

    const attackerSession = {
      id: 2,
      orgId: ATTACKER_ORG,
      surveyId: 9,
      versionId: 3,
      status: "active",
      currentQuestionId: null,
    } as never;

    await svc.join(attackerSession, {});

    const insertedValues = (values.mock.calls[0]?.[0] as { orgId?: string } | undefined);
    expect(insertedValues?.orgId).toBe(ATTACKER_ORG);
    expect(insertedValues?.orgId).not.toBe(OWNER_ORG);
  });
});
