import { SurveyResponseSubmittedConsumerService } from "./survey-response-submitted-consumer.service";
import { OutboxConsumerRegistry } from "../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-survey-1";
const EVENT_ID = "evt-aaa-bbb-ccc";
const SURVEY_ID = 42;
const SESSION_ID = 99;
const OWNER_USER_ID = "user-owner";
const RESPONDENT_USER_ID = "user-respondent";
const PARTICIPANT_ID = 7;

function makeEvent(overrides: Record<string, unknown> = {}): OutboxEventRow {
  void overrides;
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "survey_response",
    aggregateId: String(SESSION_ID),
    aggregateVersion: 1,
    eventType: "survey.response.submitted",
    payload: {
      sessionId: SESSION_ID,
      surveyId: SURVEY_ID,
      orgId: ORG_ID,
      score: 80,
      passed: null,
    },
    deliveryState: "IN_FLIGHT",
    retryCount: 0,
    schemaVersion: 1,
    audience: "INTERNAL",
    actorMembershipId: null,
    causationId: null,
    correlationId: null,
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: null,
    lastError: null,
    deadLetteredAt: null,
    lifecycleState: "ACTIVE",
    createdAt: new Date(),
  };
}

interface DbMock {
  insert: jest.Mock;
  select: jest.Mock;
  update: jest.Mock;
}

function buildDbMock(options: {
  claimed?: boolean;
  survey?: { ownerUserId: string | null } | null;
  session?: { participantId: number | null; anonymous: boolean } | null;
  participant?: { userId: string | null } | null;
}): DbMock {
  const {
    claimed = true,
    survey = { ownerUserId: OWNER_USER_ID },
    session = null,
    participant = null,
  } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const selectCalls: unknown[][] = [];
  if (survey !== undefined) selectCalls.push(survey !== null ? [survey] : []);
  if (session !== undefined) selectCalls.push(session !== null ? [session] : []);
  if (participant !== undefined) selectCalls.push(participant !== null ? [participant] : []);

  let selectCallIndex = 0;
  const dbSelect = jest.fn().mockImplementation(() => {
    const result = selectCalls[selectCallIndex] ?? [];
    selectCallIndex++;
    const limit = jest.fn().mockResolvedValue(result);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    return { from };
  });

  return { insert: dbInsert, select: dbSelect, update: dbUpdate };
}

async function buildService(options: {
  claimed?: boolean;
  survey?: { ownerUserId: string | null } | null;
  session?: { participantId: number | null; anonymous: boolean } | null;
  participant?: { userId: string | null } | null;
  emitImpl?: () => Promise<void>;
}) {
  const { emitImpl = async () => undefined } = options;

  const db = buildDbMock(options);

  const dispatch = {
    emit: jest.fn().mockImplementation(emitImpl),
  } as unknown as NotificationDispatchService;

  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      SurveyResponseSubmittedConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(SurveyResponseSubmittedConsumerService);

  return { svc, db, dispatch, registry };
}

describe("SurveyResponseSubmittedConsumerService", () => {
  describe("onModuleInit", () => {
    it("registers itself with the OutboxConsumerRegistry", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = survey.response.submitted", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("survey.response.submitted");
    });
  });

  describe("claim fence — exactly-once processing", () => {
    it("skips processing when the inbox record was already claimed", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("is idempotent: a second call with the same event does not dispatch", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      await svc.handle(makeEvent());
      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("calls db.insert to attempt the inbox claim on every handle() invocation", async () => {
      const { svc, db } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED when the payload does not match the schema", async () => {
      const { svc, db } = await buildService({ survey: null });

      const badEvent = makeEvent();
      (badEvent.payload as Record<string, unknown>)["sessionId"] = "not-a-number";

      await svc.handle(badEvent);

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    });
  });

  describe("survey not found", () => {
    it("marks inbox SKIPPED when the survey does not exist in the org", async () => {
      const { svc, dispatch, db } = await buildService({ survey: null });
      await svc.handle(makeEvent());

      expect(dispatch.emit).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });
  });

  describe("owner notification", () => {
    it("dispatches survey.response.received to the survey owner", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
      });

      await svc.handle(makeEvent());

      expect(dispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "survey.response.received",
          orgId: ORG_ID,
          targetUserIds: [OWNER_USER_ID],
          entityType: "survey",
          entityId: String(SURVEY_ID),
        }),
      );
    });

    it("skips owner notification when the survey has no ownerUserId", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: null },
      });

      await svc.handle(makeEvent());

      expect(dispatch.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: "survey.response.received" }),
      );
    });
  });

  describe("certification notification", () => {
    function makeAssessmentEvent(passed: boolean | null) {
      const evt = makeEvent();
      (evt.payload as Record<string, unknown>)["passed"] = passed;
      return evt;
    }

    it("dispatches survey.certification.passed when passed=true and respondent has a userId", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        session: { participantId: PARTICIPANT_ID, anonymous: false },
        participant: { userId: RESPONDENT_USER_ID },
      });

      await svc.handle(makeAssessmentEvent(true));

      expect(dispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "survey.certification.passed",
          orgId: ORG_ID,
          targetUserIds: [RESPONDENT_USER_ID],
          entityType: "survey_response",
          entityId: String(SESSION_ID),
        }),
      );
    });

    it("dispatches survey.certification.failed when passed=false", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        session: { participantId: PARTICIPANT_ID, anonymous: false },
        participant: { userId: RESPONDENT_USER_ID },
      });

      await svc.handle(makeAssessmentEvent(false));

      expect(dispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "survey.certification.failed",
          orgId: ORG_ID,
          targetUserIds: [RESPONDENT_USER_ID],
        }),
      );
    });

    it("skips certification notification when passed is null", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
      });

      await svc.handle(makeAssessmentEvent(null));

      expect(dispatch.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: expect.stringContaining("certification") }),
      );
    });

    it("skips certification notification when the session is anonymous", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        session: { participantId: PARTICIPANT_ID, anonymous: true },
      });

      await svc.handle(makeAssessmentEvent(true));

      expect(dispatch.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: expect.stringContaining("certification") }),
      );
    });

    it("skips certification notification when the participant has no userId (external respondent)", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        session: { participantId: PARTICIPANT_ID, anonymous: false },
        participant: { userId: null },
      });

      await svc.handle(makeAssessmentEvent(true));

      expect(dispatch.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: expect.stringContaining("certification") }),
      );
    });

    it("skips certification when session has no participantId", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        session: { participantId: null, anonymous: false },
      });

      await svc.handle(makeAssessmentEvent(true));

      expect(dispatch.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: expect.stringContaining("certification") }),
      );
    });
  });

  describe("inbox marking and error handling", () => {
    it("marks inbox COMPLETED on success", async () => {
      const { svc, db } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
      });

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });

    it("propagates a thrown error so the relay marks the outbox event RETRY, not DELIVERED", async () => {
      const { svc } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        emitImpl: async () => {
          throw new Error("downstream failure");
        },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("downstream failure");
    });
  });
});
