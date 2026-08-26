import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { PositionsTaxonomyService } from "./positions-taxonomy.service";
import {
  createPositionStatusSchema,
  updatePositionStatusSchema,
  createPositionTransitionSchema,
  updatePositionTransitionSchema,
  type CreatePositionStatusInput,
  type UpdatePositionStatusInput,
  type CreatePositionTransitionInput,
  type UpdatePositionTransitionInput,
} from "./positions-taxonomy.dto";

@RequireModule("hr")
@Controller("hr/governance/position-taxonomy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PositionsTaxonomyController {
  constructor(private readonly service: PositionsTaxonomyService) {}

  @Get("statuses")
  @RequirePermission("hr:positions:view")
  async listStatuses(@CurrentUser() user: CurrentUserContext) {
    return this.service.listStatuses(user.orgId);
  }

  @Post("statuses")
  @RequirePermission("hr:positions:manage")
  async createStatus(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createPositionStatusSchema))
    body: CreatePositionStatusInput,
  ) {
    return this.service.createStatus(user.orgId, body);
  }

  @Patch("statuses/:statusId")
  @RequirePermission("hr:positions:manage")
  async updateStatus(
    @CurrentUser() user: CurrentUserContext,
    @Param("statusId", ParseIntPipe) statusId: number,
    @Body(new ZodValidationPipe(updatePositionStatusSchema))
    body: UpdatePositionStatusInput,
  ) {
    return this.service.updateStatus(user.orgId, statusId, body);
  }

  @Delete("statuses/:statusId")
  @RequirePermission("hr:positions:manage")
  @HttpCode(200)
  async retireStatus(
    @CurrentUser() user: CurrentUserContext,
    @Param("statusId", ParseIntPipe) statusId: number,
  ) {
    return this.service.retireStatus(user.orgId, statusId);
  }

  @Get("transitions")
  @RequirePermission("hr:positions:view")
  async listTransitions(@CurrentUser() user: CurrentUserContext) {
    return this.service.listTransitions(user.orgId);
  }

  @Post("transitions")
  @RequirePermission("hr:positions:manage")
  async createTransition(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createPositionTransitionSchema))
    body: CreatePositionTransitionInput,
  ) {
    return this.service.createTransition(user.orgId, user.userId, body);
  }

  @Patch("transitions/:transitionId")
  @RequirePermission("hr:positions:manage")
  async updateTransition(
    @CurrentUser() user: CurrentUserContext,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @Body(new ZodValidationPipe(updatePositionTransitionSchema))
    body: UpdatePositionTransitionInput,
  ) {
    return this.service.updateTransition(user.orgId, transitionId, body);
  }

  @Delete("transitions/:transitionId")
  @RequirePermission("hr:positions:manage")
  @HttpCode(204)
  async deleteTransition(
    @CurrentUser() user: CurrentUserContext,
    @Param("transitionId", ParseIntPipe) transitionId: number,
  ) {
    await this.service.deleteTransition(user.orgId, transitionId);
  }
}
