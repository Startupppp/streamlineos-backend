import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { FnfService } from "./fnf.service";
import {
  createFnfSchema,
  patchFnfSchema,
  type CreateFnfInput,
  type PatchFnfInput,
} from "./dto/payroll.schemas";

@Controller("hr/fnf")
@UseGuards(JwtAuthGuard)
export class FnfController {
  constructor(private readonly fnf: FnfService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    const ability = defineAbilityFor({
      isPlatformAdmin: u.isPlatformAdmin,
      isOrgOwner: u.isOrgOwner,
      permissions: u.permissions,
      enabledModules: u.enabledModules,
    });
    const isAdmin = ability.can("approve", "hr:payroll");
    return this.fnf.listFnf(u.orgId, u.userId, isAdmin);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "hr:exit")
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createFnfSchema)) body: CreateFnfInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.fnf.createFnf(u.orgId, body);
    if (!result.ok) throw new NotFoundException("User not found in your organization");
    return result.record;
  }

  @Patch(":fnfId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "hr:exit")
  async update(
    @Param("fnfId", ParseIntPipe) fnfId: number,
    @Body(new ZodValidationPipe(patchFnfSchema)) body: PatchFnfInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.fnf.updateFnf(u.orgId, u.userId, fnfId, body);
    if (!result.ok) throw new NotFoundException("F&F settlement not found.");
    return result.record;
  }
}
