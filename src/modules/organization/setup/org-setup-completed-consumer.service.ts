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

    if (!actor)
      throw new Error(
        `Organization ${orgId} has no active membership for the setup invitation actor`,
      );

    const uniqueInvitees = new Map<string, SetupInvitee>();
    for (const invitee of invitees) {
      const email = invitee.email.trim().toLowerCase();
      if (!uniqueInvitees.has(email))
        uniqueInvitees.set(email, { ...invitee, email });
    }

    const emailsByRole = new Map<string, string[]>();
    for (const invitee of uniqueInvitees.values())
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
        "enqueue",
      );
      const failed = results.filter((result) => !result.success);
      if (failed.length > 0)
        throw new Error(
          `Failed to create ${failed.length} of ${emails.length} ${role} setup invitation(s)`,
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
