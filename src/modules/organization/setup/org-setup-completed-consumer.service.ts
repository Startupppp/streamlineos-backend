import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withSpan } from "../../../common/observability";
import { and, eq } from "drizzle-orm";
import { organizationMembers, roles, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import { runInConsumerSavepoint } from "../../../common/outbox/consumer-savepoint";
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
import { canonicalAdmissionEmail } from "../core/membership-admission.service";
import { orgSetupCompletedPayloadSchema } from "./dto/org-setup-completed-payload.schema";
import {
  canonicalSetupModuleAccess,
  setupInvitationBatchKey,
  type SetupInvitee,
  type SetupModuleAccess,
} from "./dto/org.schemas";

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
  ): Promise<string[]> {
    if (invitees.length === 0) return [];

    const [actor] = await this.db
      .select({
        isOwner: organizationMembers.isOwner,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
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

    const actorEmail = canonicalAdmissionEmail(actor.email);
    const skipped: string[] = [];
    const uniqueInvitees = new Map<string, SetupInvitee>();
    for (const invitee of invitees) {
      const email = canonicalAdmissionEmail(invitee.email);
      if (email === actorEmail) {
        if (!skipped.includes(email)) skipped.push(email);
        continue;
      }
      if (!uniqueInvitees.has(email))
        uniqueInvitees.set(email, { ...invitee, email });
    }

    if (skipped.length > 0)
      this.logger.log(
        `[org-setup] org ${orgId}: skipped ${skipped.length} wizard invitation(s) addressed to the ` +
          `acting member's own address`,
      );

    const batches = new Map<
      string,
      { role: string; moduleAccess: SetupModuleAccess; emails: string[] }
    >();
    for (const invitee of uniqueInvitees.values()) {
      const moduleAccess = canonicalSetupModuleAccess(invitee.moduleAccess ?? []);
      const key = setupInvitationBatchKey(invitee.role, moduleAccess);
      const batch = batches.get(key);
      if (batch) batch.emails.push(invitee.email);
      else batches.set(key, { role: invitee.role, moduleAccess, emails: [invitee.email] });
    }

    const failures: string[] = [];
    for (const { role, emails, moduleAccess } of batches.values()) {
      const groupLabel = moduleAccess.length > 0
        ? `${role} (${moduleAccess.map((item) => `${item.moduleKey}:${item.standing}`).join(", ")})`
        : role;
      try {
        const { results } = await runInConsumerSavepoint(() =>
          moduleAccess.length > 0
            ? this.invitations.bulkInvite(
                orgId,
                { userId: actorUserId, isOrgOwner: actor.isOwner },
                emails,
                role,
                "enqueue",
                moduleAccess,
              )
            : this.invitations.bulkInvite(
                orgId,
                { userId: actorUserId, isOrgOwner: actor.isOwner },
                emails,
                role,
                "enqueue",
              ),
        );
        const failed = results.filter((result) => !result.success);
        if (failed.length > 0)
          failures.push(
            `${groupLabel}: ${failed.length} of ${emails.length} invitation(s) failed ` +
              `(${failed
                .map((result) =>
                  result.error ? `${result.email} — ${result.error}` : result.email,
                )
                .join(", ")})`,
          );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(
          `${groupLabel}: all ${emails.length} invitation(s) failed — ${message}`,
        );
      }
    }
    return failures;
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
      await runInConsumerSavepoint(async () => {
        const [existingRole] = await this.db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.orgId, orgId))
          .limit(1);
        if (!existingRole) {
          await withSpan("org-setup.seedRoles", () =>
            seedSystemRolesForOrg(this.db, orgId),
          );
        }
        await withSpan("org-setup.ensureChecklists", () =>
          this.checklists.ensureChecklistsForModules(orgId, moduleKeys),
        );
        if (sessionAction === "complete") {
          await withSpan("org-setup.completeSession", () =>
            this.sessions.completeSession(orgId, userId, "org_setup"),
          );
        } else {
          await withSpan("org-setup.skipSession", () =>
            this.sessions.skipSession(orgId, userId, "org_setup", skipReason ?? undefined),
          );
        }
      });
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

    const optionalFailures: string[] = [];

    const runOptional = async (
      phase: string,
      fn: () => Promise<readonly string[] | void>,
    ): Promise<void> => {
      const phaseStart = Date.now();
      try {
        const reported = await runInConsumerSavepoint(() =>
          withSpan(`org-setup.${phase}`, fn),
        );
        if (reported && reported.length > 0) {
          this.logger.warn(
            `[org-setup] ${event.eventId}: ${phase} partially failed for org ${orgId} ` +
              `(${Date.now() - phaseStart}ms): ${reported.join("; ")}`,
          );
          optionalFailures.push(`${phase}: ${reported.join("; ")}`);
          return;
        }
        this.logger.log(
          `[org-setup] ${event.eventId}: ${phase} completed in ${Date.now() - phaseStart}ms`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[org-setup] ${event.eventId}: ${phase} failed for org ${orgId} (${Date.now() - phaseStart}ms): ${msg}`,
        );
        optionalFailures.push(`${phase}: ${msg}`);
      }
    };

    await runOptional("generateStructure", () =>
      this.generateStructure(orgId, industry, moduleKeys),
    );
    await runOptional("sendInvitations", () =>
      this.sendInvitations(orgId, userId, invitees),
    );
    if (sendWelcome) {
      await runOptional("sendWelcome", () =>
        this.sendWelcome(
          orgId,
          userId,
          outboxEffectIdempotencyKey(event, ORG_SETUP_COMPLETED_CONSUMER),
        ),
      );
    }

    const lastError = optionalFailures.length > 0 ? optionalFailures.join("; ") : null;
    await inbox.markProcessed(
      ORG_SETUP_COMPLETED_CONSUMER,
      event.eventId,
      "COMPLETED",
      lastError,
    );
    this.logger.log(
      `organization.setup.completed ${event.eventId}: provisioned org ${orgId} ` +
        `(${moduleKeys.length} module(s), ${invitees.length} invitation(s), session ${sessionAction})` +
        (lastError ? `; optional failures recorded: ${lastError}` : ""),
    );
  }
}
