import { Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { MembershipStateService } from "../../../common/auth/membership-state.service";
import { NotificationVisibilityRegistry } from "../../notifications/notification-visibility.registry";
import { assertPageAccessible } from "../retrieval/kb-page-access.util";

/**
 * PIPE-003. Registers KB's own page visibility with the notification pipeline, so
 * a recipient who lost access to a page between enqueue and render is not sent its
 * title or an excerpt of its content.
 *
 * KB pushes this into the registry rather than notifications pulling it — KbModule
 * already imports NotificationsModule to emit, so the reverse edge would be a cycle
 * (CLAUDE.md §24).
 */
@Injectable()
export class KbNotificationVisibility implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly membership: MembershipStateService,
    private readonly visibility: NotificationVisibilityRegistry,
  ) {}

  onModuleInit(): void {
    this.visibility.register("kb.page", (orgId, userId, entityId) =>
      this.canSeePage(orgId, userId, entityId),
    );
  }

  private async canSeePage(orgId: string, userId: string, entityId: string): Promise<boolean> {
    const pageId = Number(entityId);
    if (!Number.isInteger(pageId) || pageId <= 0) return false;

    // Membership is resolved from the database, never from a token claim (§21), and
    // this runs with no request context, so nothing here may read request state.
    const state = await this.membership.resolve(userId, orgId);
    if (!state.active) return false;

    try {
      await assertPageAccessible(
        this.db,
        {
          userId,
          orgId,
          role: state.role,
          // Deliberately empty: `pageVisibleTo` reads only userId and isOrgOwner, and
          // permissions must never be carried as claims (§21). The PAT path in
          // jwt-auth.guard.ts does the same.
          permissions: [],
          isOrgOwner: state.isOwner,
          sessionId: `notify:${userId}`,
          tokenScopes: null,
        },
        pageId,
      );
      return true;
    } catch (error: unknown) {
      // assertPageAccessible throws NotFoundException for both "gone" and "not
      // yours" — that is the correct 404-not-403 behaviour (§20) and here it simply
      // means "do not deliver". Anything else is a real fault: rethrow so the
      // registry logs it rather than silently denying.
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }
}
