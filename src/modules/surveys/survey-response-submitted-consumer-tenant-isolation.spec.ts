jest.mock("../../common/outbox/inbox-consumer");

import { SurveyResponseSubmittedConsumerService } from "./survey-response-submitted-consumer.service";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import type { Db } from "../../db/drizzle.module";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { OutboxConsumerRegistry } from "../../common/outbox/outbox-consumer.registry";

const MockedInboxConsumer = InboxConsumer as jest.MockedClass<typeof InboxConsumer>;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeEvent(organizationId: string) {
  return {
    eventId: "evt-1",
    organizationId,
    aggregateType: "survey_response",
    aggregateId: "42",
    aggregateVersion: 1,
    eventType: "survey.response.submitted",
    payload: { sessionId: 42, surveyId: 5, orgId: organizationId, score: 0, passed: null },
  } as never;
}

describe("SurveyResponseSubmittedConsumerService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  beforeEach(() => {
    MockedInboxConsumer.prototype.claim = jest.fn().mockResolvedValue(true);
    MockedInboxConsumer.prototype.markProcessed = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => jest.resetAllMocks());

  it("does not dispatch notification when survey not in the event's org (deny: isolation)", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    const dispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;
    const registry = { register: jest.fn() } as unknown as OutboxConsumerRegistry;
    const svc = new SurveyResponseSubmittedConsumerService(db, dispatch, registry);

    await svc.handle(makeEvent(ATTACKER_ORG));

    expect(dispatch.emit).not.toHaveBeenCalled();
    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("dispatches notification when survey exists in the event's org (control — same-tenant)", async () => {
    const ownerRow = { ownerUserId: "user-owner" };
    const limit = jest.fn().mockResolvedValue([ownerRow]);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;
    const registry = { register: jest.fn() } as unknown as OutboxConsumerRegistry;
    const svc = new SurveyResponseSubmittedConsumerService(db, dispatch, registry);

    await svc.handle(makeEvent(OWNER_ORG));

    expect(dispatch.emit).toHaveBeenCalledWith(expect.objectContaining({ orgId: OWNER_ORG }));
  });
});
