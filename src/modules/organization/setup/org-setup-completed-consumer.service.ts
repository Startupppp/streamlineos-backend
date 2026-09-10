import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizationMembers, users } from "../../../db/schema";
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
import {
  WorkspaceOnboardingService,
  hasStructureTemplate,
} from "../onboarding/workspace-onboarding.service";
import { InvitationCreateService } from "../core/invitation-create.service";
import { orgSetupCompletedPayloadSchema } from "./dto/org-setup-completed-payload.schema";
import type { SetupInvitee } from "./dto/org.schemas";

export const ORG_SETUP_COMPLETED_CONSUMER = "organization:setup-completed";

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
 * Two more steps have since moved in from an even weaker place. The industry workspace structure
 * and the wizard's invitations were sequenced by the BROWSER after the setup response returned, so
 * closing the tab — or a failed fetch the user never saw — dropped them with no record and no
 * retry. They are the same class of work as the other four and now run in the same place.
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
 * redelivery: `seedSystemRolesForOrg` never rewrites an existing role's grants, the checklist,
 * session and workspace-generation calls are ensure-shaped, invitations converge on one pending
 * row per email, and the welcome notification carries the outbox effect key.
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
    private readonly workspace: WorkspaceOnboardingService,
    private readonly invitations: InvitationCreateService,
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

  /**
   * The industry template is a fixed catalogue, so an industry with no template is a permanent
   * precondition miss, not a transient failure: retrying it would dead-letter an event whose other
   * five steps all succeeded. Skipped and logged rather than thrown; every other failure inside
   * `generateWorkspace` still propagates.
   */
  private async generateStructure(
    orgId: string,
    industry: string | null,
    moduleKeys: readonly string[],
  ): Promise<void> {
    if (industry === null || !hasStructureTemplate(industry)) {
      this.logger.warn(
        `organization.setup.completed: org ${orgId} has no structure template for industry ` +
          `'${industry ?? "(none)"}' — skipping workspace generation`,
      );
      return;
    }
    await this.workspace.generateWorkspace(orgId, industry, [...moduleKeys]);
  }

  /**
   * Standing is re-derived from the membership row rather than trusted from the payload: an event
   * is data, and `bulkInvite` grants a role. A payload that named a non-owner would otherwise
   * invite on their behalf with an authority the event asserted about itself.
   */
  private async sendInvitations(
    orgId: string,
    actorUserId: string,
    invitees: readonly SetupInvitee[],
  ): Promise<void> {
    if (invitees.length === 0) return;

    const [actor] = await this.db
      .select({ isOwner: organizationMembers.isOwner })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, actorUserId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);

    if (!actor) {
      this.logger.warn(
        `organization.setup.completed: org ${orgId} has no active membership for ${actorUserId} — ` +
          `skipping ${invitees.length} setup invitation(s)`,
      );
      return;
    }

    const emailsByRole = new Map<string, string[]>();
    for (const invitee of invitees)
      emailsByRole.set(invitee.role, [
        ...(emailsByRole.get(invitee.role) ?? []),
        invitee.email,
      ]);

    for (const [role, emails] of emailsByRole) {
      const { results } = await this.invitations.bulkInvite(
        orgId,
        { userId: actorUserId, isOrgOwner: actor.isOwner },
        emails,
        role,
      );
      const failed = results.filter((result) => !result.success);
      if (failed.length > 0)
        this.logger.warn(
          `organization.setup.completed: org ${orgId} could not invite ${failed.length} of ` +
            `${emails.length} ${role} address(es): ${failed
              .map((result) => `${result.email} (${result.error ?? "unknown"})`)
              .join(", ")}`,
        );
    }
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);

    const claimed = await inbox.claim(ORG_SETUP_COMPLETED_CONSUMER, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) {
      this.logger.debug(
        `organization.setup.completed ${event.eventId} already processed by ${ORG_SETUP_COMPLETED_CONSUMER} — skipping`,
      );
      return;
    }

    const parseResult = orgSetupCompletedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `organization.setup.completed ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(
        ORG_SETUP_COMPLETED_CONSUMER,
        event.eventId,
        "FAILED",
        parseResult.error.message,
      );
      return;
    }

    const {
      orgId,
      userId,
      moduleKeys,
      sessionAction,
      skipReason,
      sendWelcome,
      industry,
      invitees,
    } = parseResult.data;

    // Every step below writes into `orgId` taken from the payload, while the inbox fence, the
    // relay's lease and the audit trail are all bound to `event.organizationId`. The producer
    // sets both from the same value, so a disagreement is never legitimate — and unchecked it
    // would seed roles, provision checklists, close a session and send a welcome inside an
    // organisation the event was never recorded against. FAILED then throw: the inbox row says
    // why, and the publisher's retry ladder ends at the dead-letter the dead-outbox alert reads.
    if (orgId !== event.organizationId) {
      const message = `payload orgId does not match the event's organization (${event.organizationId})`;
      this.logger.error(
        `organization.setup.completed ${event.eventId}: ${message} — refusing to provision`,
      );
      await inbox.markProcessed(
        ORG_SETUP_COMPLETED_CONSUMER,
        event.eventId,
        "FAILED",
        message,
      );
      throw new Error(
        `organization.setup.completed ${event.eventId}: ${message}`,
      );
    }

    // A throw here is deliberate: it leaves the inbox row reclaimable, propagates to
    // OutboxPublisherService, and the event is retried and finally dead-lettered where the
    // dead-outbox alert reports it. The failure is never swallowed.
    try {
      await seedSystemRolesForOrg(this.db, orgId);
      await this.checklists.ensureChecklistsForModules(orgId, moduleKeys);
      await this.generateStructure(orgId, industry, moduleKeys);
      await this.sendInvitations(orgId, userId, invitees);
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
          outboxEffectIdempotencyKey(event, ORG_SETUP_COMPLETED_CONSUMER),
        );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await inbox.markProcessed(
        ORG_SETUP_COMPLETED_CONSUMER,
        event.eventId,
        "FAILED",
        message,
      );
      throw error;
    }

    await inbox.markProcessed(
      ORG_SETUP_COMPLETED_CONSUMER,
      event.eventId,
      "COMPLETED",
      null,
    );
    this.logger.log(
      `organization.setup.completed ${event.eventId}: provisioned org ${orgId} ` +
        `(${moduleKeys.length} module(s), ${invitees.length} invitation(s), session ${sessionAction})`,
    );
  }
}
