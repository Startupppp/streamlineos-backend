import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
  outboxEffectIdempotencyKey,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { OnboardingSessionService } from "../../hr/onboarding/flow/onboarding-session.service";
import { ModuleChecklistService } from "../../hr/onboarding/flow/module-checklist.service";
import { seedSystemRolesForOrg } from "../../rbac/seed-system-roles";
import { orgSetupCompletedPayloadSchema } from "./dto/org-setup-completed-payload.schema";

const CONSUMER_NAME = "organization:setup-completed";

/**
 * Finishes provisioning an organisation after its setup row has committed.
 *
 * This work used to run in a bare `setImmediate` inside `OrgSetupService`, with every failure
 * caught and written to a log line. Four things happened there — RBAC role seeding, module
 * checklist provisioning, closing the setup session and the welcome notification — and none of
 * them were retried. A process restart in the window between the commit and the callback, or any
 * one task throwing, left a brand-new organisation permanently half-provisioned: no roles, so its
 * owner could not open the screens they owned, and nothing anywhere recorded that it had happened.
 *
 * backend/CLAUDE.md §4 names three mechanisms for a side effect and picks between them by what a
 * crash costs. `registerAfterCommit` is the one for work that is recoverable from state already
 * stored; that is not this. Losing the role seed is a correctness bug with no other record, and
 * the welcome notification leaves the process, so this is mechanism (2): the event commits inside
 * the same transaction that stamps `onboarding_completed_at`, and the outbox relay retries it
 * until it succeeds or dead-letters where an operator can see it.
 *
 * The steps run in sequence rather than through `Promise.allSettled`, so the first failure names
 * itself, aborts the handler and is retried by the publisher. Every step is idempotent under
 * redelivery: `seedSystemRolesForOrg` never rewrites an existing role's grants, the checklist and
 * session calls are ensure-shaped, and the welcome notification carries the outbox effect key.
 */
@Injectable()
export class OrgSetupCompletedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "organization.setup.completed";
  private readonly logger = new Logger(OrgSetupCompletedConsumerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sessions: OnboardingSessionService,
    private readonly checklists: ModuleChecklistService,
    private readonly dispatch: NotificationDispatchService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  private async sendWelcome(
    orgId: string,
    userId: string,
    dedupeKey: string,
  ): Promise<void> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true, name: true, firstName: true },
    });
    if (!user?.email) return;
    const name = user.name?.trim() || user.firstName?.trim() || user.email;
    await this.dispatch.emit({
      eventKey: "organization.setup.completed",
      orgId,
      dedupeKey,
      actorUserId: userId,
      notifySelf: true,
      targetUserIds: [userId],
      entityType: "organization",
      entityId: orgId,
      title: "Organization setup complete",
      message: `Welcome to ${name}. Your organization is ready.`,
      link: "/dashboard",
      variables: { userName: name, email: user.email },
    });
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);

    const claimed = await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) {
      this.logger.debug(
        `organization.setup.completed ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = orgSetupCompletedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `organization.setup.completed ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        parseResult.error.message,
      );
      return;
    }

    const { orgId, userId, moduleKeys, sessionAction, skipReason, sendWelcome } =
      parseResult.data;

    // A throw here is deliberate: it leaves the inbox row reclaimable, propagates to
    // OutboxPublisherService, and the event is retried and finally dead-lettered where the
    // dead-outbox alert reports it. The failure is never swallowed.
    try {
      await seedSystemRolesForOrg(this.db, orgId);
      await this.checklists.ensureChecklistsForModules(orgId, moduleKeys);
      if (sessionAction === "complete")
        await this.sessions.completeSession(orgId, userId, "org_setup");
      else
        await this.sessions.skipSession(
          orgId,
          userId,
          "org_setup",
          skipReason ?? undefined,
        );
      if (sendWelcome)
        await this.sendWelcome(
          orgId,
          userId,
          outboxEffectIdempotencyKey(event, CONSUMER_NAME),
        );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", message);
      throw error;
    }

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `organization.setup.completed ${event.eventId}: provisioned org ${orgId} (${moduleKeys.length} module(s), session ${sessionAction})`,
    );
  }
}
