import { HttpException, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { MembershipStateService } from "../../../common/auth/membership-state.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { NotificationVisibilityRegistry } from "../../notifications/notification-visibility.registry";
import { ProjectsTicketsService } from "./projects-tickets.service";

/**
 * PIPE-003. Registers Build's ticket visibility with the notification pipeline, so
 * a recipient who lost access to a ticket between enqueue and render is not sent
 * its title or description.
 *
 * Build pushes this into the registry rather than notifications pulling it —
 * ProjectsModule already imports NotificationsModule to emit, so the reverse edge
 * would be a cycle (CLAUDE.md §24).
 */
@Injectable()
export class BuildNotificationVisibility implements OnModuleInit {
  private readonly logger = new Logger(BuildNotificationVisibility.name);

  constructor(
    private readonly tickets: ProjectsTicketsService,
    private readonly membership: MembershipStateService,
    private readonly visibility: NotificationVisibilityRegistry,
  ) {}

  onModuleInit(): void {
    this.visibility.register("build.ticket", (orgId, userId, entityId) =>
      this.canSeeTicket(orgId, userId, entityId),
    );
  }

  private async canSeeTicket(orgId: string, userId: string, entityId: string): Promise<boolean> {
    const ticketId = Number(entityId);
    if (!Number.isInteger(ticketId) || ticketId <= 0) return false;

    // Resolved from the database, never from a token claim (§21). This runs with no
    // request context, so nothing here may read req.rbacScope or ALS request state.
    const state = await this.membership.resolve(userId, orgId);
    if (!state.active || state.membershipId === null) return false;

    try {
      await this.tickets.getTicket(
        {
          userId,
          orgId,
          role: state.role,
          // getTicket resolves DataScope through AccessService from (orgId, userId),
          // so carrying permissions here would be both redundant and a §21 violation.
          isOrgOwner: state.isOwner,
          sessionId: `notify:${userId}`,
          tokenScopes: null,
          principal: humanSessionPrincipal(state.membershipId, state.isOwner),
        },
        ticketId,
      );
      return true;
    } catch (err) {
      if (!(err instanceof HttpException))
        logSideEffectFailure("ticket visibility check", { orgId, userId, entityId })(err);
      return false;
    }
  }
}
