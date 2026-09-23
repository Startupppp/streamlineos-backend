import {
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { MembershipStateService } from "../../../common/auth/membership-state.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { NotificationVisibilityRegistry } from "../../notifications/notification-visibility.registry";
import { KnowledgeAuthorizationService } from "./authorization/knowledge-authorization.service";

@Injectable()
export class KbNotificationVisibility implements OnModuleInit {
  constructor(
    private readonly membership: MembershipStateService,
    private readonly visibility: NotificationVisibilityRegistry,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  onModuleInit(): void {
    this.visibility.register("kb.page", (orgId, userId, entityId) =>
      this.canSeePage(orgId, userId, entityId),
    );
  }

  private async canSeePage(
    orgId: string,
    userId: string,
    entityId: string,
  ): Promise<boolean> {
    const pageId = Number(entityId);
    if (!Number.isInteger(pageId) || pageId <= 0) return false;

    const state = await this.membership.resolve(userId, orgId);
    if (!state.active || state.membershipId === null) return false;

    try {
      await this.auth.assertPageAccess(
        {
          userId,
          orgId,
          role: state.role,
          isOrgOwner: state.isOwner,
          sessionId: `notify:${userId}`,
          tokenScopes: null,
          principal: humanSessionPrincipal(state.membershipId, state.isOwner),
        },
        pageId,
        "view",
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }
}
