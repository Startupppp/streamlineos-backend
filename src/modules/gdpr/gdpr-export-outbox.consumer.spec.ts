import { randomUUID } from "node:crypto";
import type { OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { OutboxConsumerRegistry } from "../../common/outbox/outbox-consumer.registry";
import { GdprExportRequestedConsumer } from "./gdpr-export-outbox.consumer";
import {
  GDPR_EXPORT_AGGREGATE_TYPE,
  GDPR_EXPORT_REQUESTED_EVENT,
  gdprExportRequestedPayloadSchema,
} from "./dto/gdpr-export-outbox.schemas";
import type { GdprExportWorkerService } from "./gdpr-export-worker.service";

const ORG = "org-export-consumer";
const JOB_ID = randomUUID();

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: randomUUID(),
    organizationId: ORG,
    aggregateType: GDPR_EXPORT_AGGREGATE_TYPE,
    aggregateId: JOB_ID,
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "PENDING",
    eventType: GDPR_EXPORT_REQUESTED_EVENT,
    payload: { jobId: JOB_ID, orgId: ORG },
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeConsumer(): {
  consumer: GdprExportRequestedConsumer;
  wake: jest.Mock;
  registry: OutboxConsumerRegistry;
} {
  const wake = jest.fn();
  const worker = { wake } as unknown as GdprExportWorkerService;
  const registry = new OutboxConsumerRegistry();
  return { consumer: new GdprExportRequestedConsumer(worker, registry), wake, registry };
}

describe("gdprExportRequestedPayloadSchema", () => {
  it("is closed — an unexpected key is rejected, not silently stripped", () => {
    const withExtra = gdprExportRequestedPayloadSchema.safeParse({
      jobId: JOB_ID,
      orgId: ORG,
      subjectUserId: "user-someone-else",
    });
    expect(withExtra.success).toBe(false);
  });

  it("rejects a payload whose tenant field was dropped rather than defaulting it", () => {
    const dropped = gdprExportRequestedPayloadSchema.safeParse({ jobId: JOB_ID });
    expect(dropped.success).toBe(false);
    const parsed = gdprExportRequestedPayloadSchema.safeParse({
      jobId: JOB_ID,
      orgId: ORG,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.orgId).toBe(ORG);
  });

  it("rejects a jobId that is not a uuid", () => {
    expect(
      gdprExportRequestedPayloadSchema.safeParse({ jobId: "not-a-uuid", orgId: ORG }).success,
    ).toBe(false);
  });
});

describe("GdprExportRequestedConsumer", () => {
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("registers itself for the export-requested event type", () => {
    const { consumer, registry } = makeConsumer();
    consumer.onModuleInit();
    expect(registry.get(GDPR_EXPORT_REQUESTED_EVENT)).toBe(consumer);
    expect(consumer.eventType).toBe(GDPR_EXPORT_REQUESTED_EVENT);
  });

  it("wakes the worker for a valid payload", async () => {
    const { consumer, wake } = makeConsumer();
    await consumer.handle(makeEvent());
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("throws rather than reporting delivered when the payload does not parse", async () => {
    const { consumer, wake } = makeConsumer();
    await expect(
      consumer.handle(makeEvent({ payload: { orgId: ORG } })),
    ).rejects.toThrow(/invalid payload/);
    expect(wake).not.toHaveBeenCalled();
  });

  it("throws on an unexpected key, so a drifted producer cannot report success", async () => {
    const { consumer, wake } = makeConsumer();
    await expect(
      consumer.handle(
        makeEvent({ payload: { jobId: JOB_ID, orgId: ORG, subjectUserId: "user-x" } }),
      ),
    ).rejects.toThrow(/invalid payload/);
    expect(wake).not.toHaveBeenCalled();
  });

  it("refuses a payload whose orgId disagrees with the event's organization", async () => {
    const { consumer, wake } = makeConsumer();
    await expect(
      consumer.handle(makeEvent({ payload: { jobId: JOB_ID, orgId: "org-other-tenant" } })),
    ).rejects.toThrow(/does not match the event's organization/);
    expect(wake).not.toHaveBeenCalled();
  });

  it("lets a worker failure propagate to the relay rather than swallowing it", async () => {
    const { consumer, wake } = makeConsumer();
    wake.mockImplementation(() => {
      throw new Error("GDPR_EXPORT_STORAGE_NOT_CONFIGURED");
    });
    await expect(consumer.handle(makeEvent())).rejects.toThrow(
      "GDPR_EXPORT_STORAGE_NOT_CONFIGURED",
    );
  });
});
