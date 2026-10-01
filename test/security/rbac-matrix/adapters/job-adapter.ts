import { BuildReleasePublishedConsumerService } from "src/modules/build/core";
import type { OutboxEventRow, OutboxConsumerRegistry } from "src/common/outbox/outbox-consumer.registry";
import type { NotificationDispatchService } from "src/modules/notifications/notification-dispatch.service";
import type { Observation } from "../matrix.types";
import { boundValues, standIn, type WorldDb } from "../world-db";

interface DispatchCall {
  readonly orgId: string;
  readonly targetUserIds: readonly string[];
}

function releaseEvent(organizationId: string, releaseId: number): OutboxEventRow {
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
    eventType: "build.release.published",
    payload: { releaseId, projectId: 11, orgId: organizationId, name: `v${releaseId}`, version: `v${releaseId}` },
    occurredAt: new Date(0),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(0),
  };
}

export async function releaseNotification(
  world: WorldDb,
  eventOrg: string,
  releaseId: number,
  dataOrg: string,
  dataUsers: readonly string[],
): Promise<Observation> {
  const calls: DispatchCall[] = [];
  const dispatch = standIn<NotificationDispatchService>({
    emit: async (input: DispatchCall) => {
      calls.push(input);
      return { delivered: input.targetUserIds.length };
    },
  });
  const registry = standIn<OutboxConsumerRegistry>({ register: () => undefined });
  const readsBefore = world.reads.length;
  await new BuildReleasePublishedConsumerService(world.db, dispatch, registry).handle(releaseEvent(eventOrg, releaseId));
  const ownerReads = world.reads.slice(readsBefore).filter((read) => read.table === "release_tickets");
  const bound = ownerReads.flatMap((read) => boundValues(read.where));
  const reached = calls.flatMap((call) => call.targetUserIds).filter((user) => dataUsers.includes(user));
  const reachedForeign = eventOrg !== dataOrg && reached.length > 0;
  return {
    outcome: reached.length > 0 ? "allow" : "404",
    checks: {
      ownerQueryRan: ownerReads.length === 1,
      ownerQueryBindsEventOrg: bound.includes(eventOrg),
      ownerQueryNeverBindsAnotherOrg: eventOrg === dataOrg || !bound.includes(dataOrg),
      dispatchCarriesEventOrg: calls.every((call) => call.orgId === eventOrg),
      noForeignRecipient: !reachedForeign,
    },
  };
}
