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

function buildInboxSelectChain(returning: unknown[]) {
  const ret = jest.fn().mockResolvedValue(returning);
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning: ret });
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  return { insert, _returning: ret };
}

function buildSelectChain(result: unknown[]) {
  const limit = jest.fn().mockResolvedValue(result);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { select };
}

function buildUpdateChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { update };
}

interface TxMock {
  insert: jest.Mock;
  select: jest.Mock;
  update: jest.Mock;
}

function buildTx(overrides: Partial<TxMock> = {}): TxMock {
  return {
    insert: overrides.insert ?? jest.fn(),
    select: overrides.select ?? jest.fn(),
    update: overrides.update ?? jest.fn(),
  };
}

async function buildService(options: {
  claimed?: boolean;
  survey?: { ownerUserId: string | null } | null;
  session?: { participantId: number | null; anonymous: boolean } | null;
  participant?: { userId: string | null } | null;
  emitDurableImpl?: () => Promise<void>;
}) {
  const {
    claimed = true,
    survey = { ownerUserId: OWNER_USER_ID },
    session = null,
    participant = null,
    emitDurableImpl = async () => undefined,
  } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const markProcessedWhere = jest.fn().mockResolvedValue(undefined);
  const markProcessedSet = jest.fn().mockReturnValue({ where: markProcessedWhere });
  const markProcessedUpdate = jest.fn().mockReturnValue({ set: markProcessedSet });

  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const claimInsert = jest.fn().mockReturnValue({ values: claimValues });

  const selectCalls: unknown[][] = [];
  if (survey !== undefined) selectCalls.push(survey !== null ? [survey] : []);
  if (session !== undefined) selectCalls.push(session !== null ? [session] : []);
  if (participant !== undefined) selectCalls.push(participant !== null ? [participant] : []);

  let selectCallIndex = 0;
  const txSelect = jest.fn().mockImplementation(() => {
    const result = selectCalls[selectCallIndex] ?? [];
    selectCallIndex++;
    const limit = jest.fn().mockResolvedValue(result);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    return { from };
  });

  const tx: TxMock & { update: jest.Mock } = {
    insert: claimInsert,
    select: txSelect,
    update: markProcessedUpdate,
  };

  const db = {
    transaction: jest.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };

  const dispatch = {
    emitDurable: jest.fn().mockImplementation(emitDurableImpl),
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

  return { svc, db, dispatch, registry, tx };
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
      expect(dispatch.emitDurable).not.toHaveBeenCalled();
    });

    it("is idempotent: a second call with the same event is skipped", async () => {
      const { svc, dispatch, db } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      await svc.handle(makeEvent());
      expect(dispatch.emitDurable).not.toHaveBeenCalled();
      expect(db.transaction).toHaveBeenCalledTimes(2);
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED when the payload does not match the schema", async () => {
      const { svc, tx } = await buildService({ survey: null });

      const badEvent = makeEvent();
      (badEvent.payload as Record<string, unknown>)["sessionId"] = "not-a-number";

      await svc.handle(badEvent);

      const updateArg = (tx.update as jest.Mock).mock.calls[0];
      expect(updateArg).toBeDefined();
      const setCall = (tx.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    });
  });

  describe("survey not found", () => {
    it("marks inbox SKIPPED when the survey does not exist in the org", async () => {
      const { svc, dispatch, tx } = await buildService({ survey: null });
      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).not.toHaveBeenCalled();
      const setCall = (tx.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });
  });

  describe("owner notification", () => {
    it("dispatches survey.response.received to the survey owner", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
      });

      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).toHaveBeenCalledWith(
        expect.anything(),
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

      expect(dispatch.emitDurable).not.toHaveBeenCalledWith(
        expect.anything(),
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

      expect(dispatch.emitDurable).toHaveBeenCalledWith(
        expect.anything(),
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

      expect(dispatch.emitDurable).toHaveBeenCalledWith(
        expect.anything(),
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

      expect(dispatch.emitDurable).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventKey: expect.stringContaining("certification") }),
      );
    });

    it("skips certification notification when the session is anonymous", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        session: { participantId: PARTICIPANT_ID, anonymous: true },
      });

      await svc.handle(makeAssessmentEvent(true));

      expect(dispatch.emitDurable).not.toHaveBeenCalledWith(
        expect.anything(),
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

      expect(dispatch.emitDurable).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventKey: expect.stringContaining("certification") }),
      );
    });

    it("skips certification when session has no participantId", async () => {
      const { svc, dispatch } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        session: { participantId: null, anonymous: false },
      });

      await svc.handle(makeAssessmentEvent(true));

      expect(dispatch.emitDurable).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventKey: expect.stringContaining("certification") }),
      );
    });
  });

  describe("transaction boundaries and error handling", () => {
    it("runs all work inside a single transaction", async () => {
      const { svc, db } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
      });

      await svc.handle(makeEvent());

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it("marks inbox COMPLETED inside the transaction on success", async () => {
      const { svc, tx } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
      });

      await svc.handle(makeEvent());

      const setCall = (tx.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });

    it("propagates a thrown error so the relay marks the outbox event RETRY, not DELIVERED", async () => {
      const { svc } = await buildService({
        survey: { ownerUserId: OWNER_USER_ID },
        emitDurableImpl: async () => {
          throw new Error("downstream failure");
        },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("downstream failure");
    });
  });
});
