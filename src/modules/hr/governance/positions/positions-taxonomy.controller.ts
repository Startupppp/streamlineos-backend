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
import { PositionsTaxonomyService } from "./positions-taxonomy.service";
import { PositionsTransitionsService } from "./positions-transitions.service";
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
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";

const statusIdParams = z.object({ statusId: z.coerce.number().int().positive() }).strict();
const transitionIdParams = z.object({ transitionId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/governance/position-taxonomy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PositionsTaxonomyController {
  constructor(
    private readonly service: PositionsTaxonomyService,
    private readonly transitions: PositionsTransitionsService,
  ) {}

  @Get("statuses")
  @RequirePermission("hr:positions:view")
  async listStatuses(@CurrentUser() user: CurrentUserContext) {
    return this.service.listStatuses(user.orgId);
  }

  @Post("statuses")
  @RequirePermission("hr:positions:manage")
  @Validate({ body: createPositionStatusSchema })
  async createStatus(
    @CurrentUser() user: CurrentUserContext,
    @Body()
    body: CreatePositionStatusInput,
  ) {
    return this.service.createStatus(user.orgId, body);
  }

  @Patch("statuses/:statusId")
  @RequirePermission("hr:positions:manage")
  @Validate({ params: statusIdParams, body: updatePositionStatusSchema })
  async updateStatus(
    @CurrentUser() user: CurrentUserContext,
    @Param("statusId", ParseIntPipe) statusId: number,
    @Body()
    body: UpdatePositionStatusInput,
  ) {
    return this.service.updateStatus(user.orgId, statusId, body);
  }

  @Delete("statuses/:statusId")
  @RequirePermission("hr:positions:manage")
  @HttpCode(200)
  @Validate({ params: statusIdParams })
  async retireStatus(
    @CurrentUser() user: CurrentUserContext,
    @Param("statusId", ParseIntPipe) statusId: number,
  ) {
    return this.service.retireStatus(user.orgId, statusId);
  }

  @Get("transitions")
  @RequirePermission("hr:positions:view")
  async listTransitions(@CurrentUser() user: CurrentUserContext) {
    return this.transitions.listTransitions(user.orgId);
  }

  @Post("transitions")
  @RequirePermission("hr:positions:manage")
  @Validate({ body: createPositionTransitionSchema })
  async createTransition(
    @CurrentUser() user: CurrentUserContext,
    @Body()
    body: CreatePositionTransitionInput,
  ) {
    return this.transitions.createTransition(user.orgId, user.userId, body);
  }

  @Patch("transitions/:transitionId")
  @RequirePermission("hr:positions:manage")
  @Validate({ params: transitionIdParams, body: updatePositionTransitionSchema })
  async updateTransition(
    @CurrentUser() user: CurrentUserContext,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @Body()
    body: UpdatePositionTransitionInput,
  ) {
    return this.transitions.updateTransition(user.orgId, transitionId, body);
  }

  @Delete("transitions/:transitionId")
  @RequirePermission("hr:positions:manage")
  @HttpCode(204)
  @Validate({ params: transitionIdParams })
  async deleteTransition(
    @CurrentUser() user: CurrentUserContext,
    @Param("transitionId", ParseIntPipe) transitionId: number,
  ) {
    await this.transitions.deleteTransition(user.orgId, transitionId);
  }
}
