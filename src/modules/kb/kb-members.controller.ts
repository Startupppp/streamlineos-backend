import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbMembersService } from "./kb-members.service";
import { addMemberSchema, type AddMemberInput } from "./dto/kb-members.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, AbilityGuard)
@RequireModule("kb")
export class KbMembersController {
  constructor(private readonly members: KbMembersService) {}

  @Get("spaces/:spaceId/members")
  @CheckAbility("manage", "kb:spaces")
  list(@Param("spaceId", ParseIntPipe) spaceId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.list(u.orgId, spaceId);
  }

  @Post("spaces/:spaceId/members")
  @CheckAbility("manage", "kb:spaces")
  add(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.add(u.orgId, spaceId, body);
  }

  @Delete("spaces/:spaceId/members/:memberId")
  @CheckAbility("manage", "kb:spaces")
  remove(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Param("memberId", ParseIntPipe) memberId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.remove(u.orgId, spaceId, memberId);
  }
}
