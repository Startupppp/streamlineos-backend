import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbSpacesService } from "./kb-spaces.service";
import {
  createSpaceSchema,
  updateSpaceSchema,
  type CreateSpaceInput,
  type UpdateSpaceInput,
} from "./dto/kb.schemas";

@Controller("kb/spaces")
@UseGuards(JwtAuthGuard, ModuleGuard, AbilityGuard)
@RequireModule("kb")
export class KbSpacesController {
  constructor(private readonly spaces: KbSpacesService) {}

  @Get()
  @CheckAbility("view", "kb:spaces")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.spaces.list(u);
  }

  @Post()
  @CheckAbility("manage", "kb:spaces")
  create(
    @Body(new ZodValidationPipe(createSpaceSchema)) body: CreateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.spaces.create(u.orgId, u.userId, body);
  }

  @Get(":spaceId")
  @CheckAbility("view", "kb:spaces")
  get(@Param("spaceId", ParseIntPipe) spaceId: number, @CurrentUser() u: CurrentUserContext) {
    return this.spaces.get(u, spaceId);
  }

  @Patch(":spaceId")
  @CheckAbility("manage", "kb:spaces")
  update(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body(new ZodValidationPipe(updateSpaceSchema)) body: UpdateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.spaces.update(u.orgId, spaceId, body);
  }

  @Delete(":spaceId")
  @CheckAbility("manage", "kb:spaces")
  remove(@Param("spaceId", ParseIntPipe) spaceId: number, @CurrentUser() u: CurrentUserContext) {
    return this.spaces.remove(u.orgId, spaceId);
  }
}
