import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { AbilityGuard } from "../common/rbac/ability.guard";
import { CheckAbility } from "../common/rbac/check-ability.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import { AccessService } from "../modules/access/access.service";
import type { AccessSnapshot } from "../modules/access/access.types";

@Controller("me")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class MeController {
  constructor(private readonly access: AccessService) {}

  @Get()
  me(@CurrentUser() user: CurrentUserContext): CurrentUserContext {
    return user;
  }

  @Get("access")
  getAccess(@CurrentUser() u: CurrentUserContext): Promise<AccessSnapshot> {
    return this.access.getAccessSnapshot(u.orgId, u.userId, u);
  }

  @Get("protected")
  @CheckAbility("delete", "crm:leads")
  protected(@CurrentUser() user: CurrentUserContext): { ok: true; userId: string } {
    return { ok: true, userId: user.userId };
  }
}
