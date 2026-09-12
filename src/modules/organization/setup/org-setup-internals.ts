import { and, eq, isNull } from "drizzle-orm";
import { organizations } from "../../../db/schema";
import { randomUUID } from "node:crypto";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { SetupInvitee } from "./dto/org.schemas";
import type { z } from "zod";
import { orgSetupStatusErrorCodeSchema } from "./dto/org-setup-response.schemas";

export type OrgSetupProvisioningState =
  | "not-started"
  | "pending"
  | "in-progress"
  | "completed"
  | "failed";

export interface OrgSetupStatus {
  orgId: string | null;
  onboardingCompletedAt: Date | null;
  ready: boolean;
  provisioning: OrgSetupProvisioningState;
  errorCode: z.infer<typeof orgSetupStatusErrorCodeSchema> | null;
  correlationId: string | null;
}

export const READY_ENTITLEMENT_STATUSES = ["TRIAL", "ACTIVE", "PAST_DUE"] as const;

/**
 * The setup work that must outlive the request: RBAC role seeding, module checklists, the
 * industry workspace structure, the wizard's invitations, closing the setup session and the
 * welcome notification.
 *
 * It used to run in a bare `setImmediate` whose only failure handler was a log line, so a crash
 * or a single throwing step left a new organisation half-provisioned with nothing to retry it.
 * The structure generation and the invitations were worse still: the BROWSER sequenced them
 * after the response, so closing the tab dropped them. Emitting inside the caller's transaction
 * makes the intent commit atomically with `onboarding_completed_at`;
 * `OrgSetupCompletedConsumerService` performs it, and the outbox relay retries until it succeeds
 * or dead-letters visibly.
 */
export function emitSetupCompleted(
  tx: TenantTx,
  now: Date,
  input: {
    orgId: string;
    userId: string;
    moduleKeys: readonly string[];
    sessionAction: "complete" | "skip";
    skipReason?: string;
    sendWelcome: boolean;
    industry: string | null;
    invitees: readonly SetupInvitee[];
  },
): Promise<void> {
  return OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    organizationId: input.orgId,
    aggregateType: "organization",
    aggregateId: input.orgId,
    aggregateVersion: now.getTime(),
    eventType: "organization.setup.completed",
    payload: {
      orgId: input.orgId,
      userId: input.userId,
      moduleKeys: [...input.moduleKeys],
      sessionAction: input.sessionAction,
      skipReason: input.skipReason ?? null,
      sendWelcome: input.sendWelcome,
      industry: input.industry,
      invitees: input.invitees.map((invitee) => ({ ...invitee })),
    },
    occurredAt: now,
  });
}

/**
 * The wizard's natural idempotency (no `@Idempotent`, which would 400 every caller that sends
 * no `Idempotency-Key`).
 *
 * The stamp is claimed by a conditional UPDATE rather than a read-then-write, so two concurrent
 * replays cannot both see a null and both proceed. A replay that loses the race writes nothing:
 * no second `organization.setup.completed` with `sendWelcome: true`, and no second
 * `magic_link_tokens` row — that row is a login credential, and minting a fresh one per retry
 * hands out a new one on every double-submit.
 */
export async function claimOnboardingStamp(
  tx: TenantTx,
  orgId: string,
  now: Date,
  profile: Partial<typeof organizations.$inferInsert>,
): Promise<boolean> {
  const claimed = await tx
    .update(organizations)
    .set({ ...profile, onboardingCompletedAt: now })
    .where(
      and(
        eq(organizations.id, orgId),
        isNull(organizations.onboardingCompletedAt),
      ),
    )
    .returning({ id: organizations.id });
  return claimed.length > 0;
}

type ErrorCode = z.infer<typeof orgSetupStatusErrorCodeSchema>;

/**
 * `COMPLETED` with a non-null `lastError` is how the consumer records an OPTIONAL phase
 * (workspace template, invitations, welcome) that failed while every REQUIRED phase succeeded.
 * It must not read as `failed` — the relay will never retry a COMPLETED row, so a failure verdict
 * would strand the wizard — but it must not read as an unqualified success either, or an owner
 * whose invitations all failed is told setup finished cleanly.
 */
export function resolveProvisioningAndError(
  inboxStatus: string | null,
  outboxDeliveryState: string | null,
  hasOptionalFailure: boolean,
): { provisioning: OrgSetupProvisioningState; errorCode: ErrorCode | null } {
  if (inboxStatus === null) {
    if (outboxDeliveryState === "DEAD")
      return { provisioning: "failed", errorCode: "SETUP_BACKGROUND_DEAD" };
    if (outboxDeliveryState === "SUPPRESSED")
      return { provisioning: "failed", errorCode: "SETUP_BACKGROUND_SUPPRESSED" };
    return { provisioning: "pending", errorCode: null };
  }
  if (inboxStatus === "COMPLETED" || inboxStatus === "SKIPPED")
    return {
      provisioning: "completed",
      errorCode: hasOptionalFailure ? "SETUP_BACKGROUND_PARTIAL" : null,
    };
  if (inboxStatus === "PENDING" || inboxStatus === "IN_FLIGHT")
    return { provisioning: "in-progress", errorCode: null };
  if (inboxStatus === "FAILED") {
    if (outboxDeliveryState === "PENDING" || outboxDeliveryState === "IN_FLIGHT")
      return { provisioning: "in-progress", errorCode: "SETUP_BACKGROUND_RETRYING" };
    if (outboxDeliveryState === "DEAD")
      return { provisioning: "failed", errorCode: "SETUP_BACKGROUND_DEAD" };
    if (outboxDeliveryState === "SUPPRESSED")
      return { provisioning: "failed", errorCode: "SETUP_BACKGROUND_SUPPRESSED" };
    if (outboxDeliveryState === "DELIVERED")
      return { provisioning: "failed", errorCode: "SETUP_BACKGROUND_INVALID" };
    return { provisioning: "failed", errorCode: null };
  }
  return { provisioning: "in-progress", errorCode: null };
}
