import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { CurrentUser } from "../common/auth/current-user.decorator";
import { AbilityGuard } from "../common/rbac/ability.guard";
import { CheckAbility } from "../common/rbac/check-ability.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import { AuthService, type AccessBootstrap } from "../modules/auth/auth.service";

@Controller("me")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class MeController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  me(@CurrentUser() user: CurrentUserContext): CurrentUserContext {
    return user;
  }

  @Get("access")
  access(@CurrentUser() user: CurrentUserContext): Promise<AccessBootstrap> {
    return this.authService.getAccessBootstrap(user.userId, user.orgId);
  }

  @Get("protected")
  @CheckAbility("delete", "crm:leads")
  protected(@CurrentUser() user: CurrentUserContext): { ok: true; userId: string } {
    return { ok: true, userId: user.userId };
  }
}
