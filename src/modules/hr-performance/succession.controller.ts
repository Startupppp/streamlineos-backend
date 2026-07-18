import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { SuccessionService } from "./succession.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createSuccessionPlanSchema,
  updateSuccessionPlanSchema,
  type CreateSuccessionPlanInput,
  type UpdateSuccessionPlanInput,
} from "./dto/succession.schemas";

@RequireModule("hr")
@Controller("hr/succession")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SuccessionController {
  constructor(private readonly successionService: SuccessionService) {}

  @Get()
  @RequirePermission("hr:succession:view")
  list(@CurrentUser() user: CurrentUserContext) {
    return this.successionService.list(user.orgId);
  }

  @Post()
  @RequirePermission("hr:succession:manage")
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createSuccessionPlanSchema)) body: CreateSuccessionPlanInput,
  ) {
    return this.successionService.create(user.orgId, user.userId, body);
  }

  @Patch(":id")
  @RequirePermission("hr:succession:manage")
  update(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateSuccessionPlanSchema)) body: UpdateSuccessionPlanInput,
  ) {
    return this.successionService.update(user.orgId, id, body);
  }

  @Delete(":id")
  @RequirePermission("hr:succession:manage")
  remove(@CurrentUser() user: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.successionService.remove(user.orgId, id);
  }
}
