import { and, eq } from "drizzle-orm";
import { outboxEvents } from "src/db/schema";
import { forEachOrg } from "src/common/tenant/for-each-org";
import { getTenantContext } from "src/common/tenant/tenant-context";
import { OutboxBatchClaimer } from "src/common/outbox/outbox-claim";
import { OutboxConsumerRegistry, type OutboxEventRow } from "src/common/outbox/outbox-consumer.registry";
import { OutboxPublisherService } from "src/common/outbox/outbox-publisher.service";
import type { AppConfig } from "src/config/env.validation";
import { BuildReleasePublishedConsumerService } from "src/modules/build/core/releases/build-release-published-consumer.service";
import type { NotificationDispatchService } from "src/modules/notifications/notification-dispatch.service";
import type { Observation } from "../matrix.types";
import { PROJECT_A, matrixRows } from "../fixtures";
import { boundValues, mergeRows, standIn, worldDb, type WorldDb } from "../world-db";

const EVENT_TYPE = "build.release.published";

interface DispatchCall {
  readonly orgId: string;
  readonly targetUserIds: readonly string[];
}

class WorldClaimer extends OutboxBatchClaimer {
  constructor(private readonly world: WorldDb) {
    super(world.db);
  }

  async claim(): Promise<OutboxEventRow[]> {
    const claimed: OutboxEventRow[] = [];
    const leaseUntil = new Date(Date.now() + 60_000);
    await forEachOrg(this.world.db, "rbac-matrix-outbox-claim", async (tx, orgId) => {
      const rows = await tx
        .update(outboxEvents)
        .set({ deliveryState: "IN_FLIGHT", leaseExpiresAt: leaseUntil })
        .where(and(eq(outboxEvents.organizationId, orgId), eq(outboxEvents.deliveryState, "PENDING")))
        .returning();
      claimed.push(...rows);
    });
    return claimed;
  }
}

function releaseEvent(organizationId: string, releaseId: number): Record<string, unknown> {
  return {
    outboxEventId: releaseId,
    eventId: `ev-${organizationId}-${releaseId}`,
    organizationId,
    aggregateType: "release",
    aggregateId: String(releaseId),
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "PENDING",
    eventType: EVENT_TYPE,
    payload: { releaseId, projectId: PROJECT_A, orgId: organizationId, name: `v${releaseId}`, version: `v${releaseId}` },
    occurredAt: new Date(0),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(0),
  };
}

export async function releaseNotificationJob(
  eventOrg: string,
  releaseId: number,
  dataOrg: string,
  dataUsers: readonly string[],
): Promise<Observation> {
  const world = worldDb(mergeRows(matrixRows(), new Map([[outboxEvents, [releaseEvent(eventOrg, releaseId)]]])), { mutable: true });
  const calls: DispatchCall[] = [];
  const dispatch = standIn<NotificationDispatchService>({
    emit: async (input: DispatchCall) => {
      calls.push(input);
      return { delivered: input.targetUserIds.length };
    },
    emitInTx: async () => undefined,
  });
  const registry = new OutboxConsumerRegistry();
  new BuildReleasePublishedConsumerService(world.db, dispatch, registry).onModuleInit();
  const contexts: Array<{ readonly ambient: string | undefined; readonly guc: string | undefined }> = [];
  registry.register({
    eventType: EVENT_TYPE,
    handle: async () => {
      contexts.push({ ambient: getTenantContext()?.orgId, guc: world.settings.at(-1)?.["app.organization_id"] });
    },
  });
  const publisher = new OutboxPublisherService(world.db, standIn<AppConfig>({ OUTBOX_DISPATCH_ENABLED: "true" }), registry, standIn({}));
  Reflect.set(publisher, "claimer", new WorldClaimer(world));
  const readsBefore = world.reads.length;
  const result = await publisher.flush();
  const ownerReads = world.reads.slice(readsBefore).filter((read) => read.table === "release_tickets");
  const bound = ownerReads.flatMap((read) => boundValues(read.where));
  const reached = calls.flatMap((call) => call.targetUserIds).filter((user) => dataUsers.includes(user));
  return {
    outcome: reached.length > 0 ? "allow" : "404",
    checks: {
      claimedTheEvent: result.claimed === 1,
      deliveredWithoutRetry: result.delivered === 1,
      consumerRanInTheEventTenant: contexts.length === 1 && contexts[0].ambient === eventOrg && contexts[0].guc === eventOrg,
      ownerQueryBindsEventOrg: ownerReads.length === 1 && bound.includes(eventOrg),
      ownerQueryNeverBindsAnotherOrg: eventOrg === dataOrg || !bound.includes(dataOrg),
      dispatchCarriesEventOrg: calls.every((call) => call.orgId === eventOrg),
    },
  };
}
