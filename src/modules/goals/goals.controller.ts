import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  GoalsService,
  isLinkGoalNotFound,
  isLinkProjectNotFound,
  isLinkTicketNotFound,
} from "./goals.service";
import {
  checkInSchema,
  createLinkSchema,
  createSchema,
  deleteLinkSchema,
  listSchema,
  updateSchema,
  type CheckInInput,
  type CreateInput,
  type CreateLinkInput,
  type DeleteLinkInput,
  type ListInput,
  type UpdateInput,
} from "./dto/goal.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const goalIdParams = z.object({ goalId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("goals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  @RequirePermission("build:goals:view")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.list(u, filters);
  }

  @Post()
  @RequirePermission("build:goals:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.create(u.orgId, u.userId, body);
  }

  @Get("stats")
  @RequirePermission("build:goals:view")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.goals.getStats(u.orgId);
  }

  @Get(":goalId")
  @RequirePermission("build:goals:view")
  @Validate({ params: goalIdParams })
  async get(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const goal = await this.goals.getGoal(u.orgId, goalId);
    if (!goal) throw new NotFoundException("Goal not found");
    return goal;
  }

  @Patch(":goalId")
  @RequirePermission("build:goals:manage")
  @Validate({ params: goalIdParams })
  async update(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.goals.update(u.orgId, goalId, body);
    if (!updated) throw new NotFoundException("Goal not found");
    return updated;
  }

  @Delete(":goalId")
  @RequirePermission("build:goals:manage")
  @HttpCode(204)
  @Validate({ params: goalIdParams })
  async remove(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.goals.remove(u.orgId, goalId);
    if (!result) throw new NotFoundException("Goal not found");
  }

  @Post(":goalId/check-in")
  @RequirePermission("build:goals:manage")
  @Validate({ params: goalIdParams })
  async checkIn(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body(new ZodValidationPipe(checkInSchema)) body: CheckInInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const goal = await this.goals.checkIn(u.orgId, u.userId, goalId, body);
    if (!goal) throw new NotFoundException("Key result not found");
    return goal;
  }

  @Get(":goalId/links")
  @RequirePermission("build:goals:view")
  @Validate({ params: goalIdParams })
  getLinks(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.getLinks(u.orgId, goalId);
  }

  @Post(":goalId/links")
  @RequirePermission("build:goals:manage")
  @HttpCode(201)
  @Validate({ params: goalIdParams })
  async createLink(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body(new ZodValidationPipe(createLinkSchema)) body: CreateLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.goals.createLink(u.orgId, goalId, body);
    if (isLinkGoalNotFound(result)) throw new NotFoundException("Goal not found");
    if (isLinkTicketNotFound(result)) throw new NotFoundException("Ticket not found");
    if (isLinkProjectNotFound(result)) throw new NotFoundException("Project not found");
    return result;
  }

  @Delete(":goalId/links")
  @RequirePermission("build:goals:manage")
  @Validate({ params: goalIdParams })
  async removeLink(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Query(new ZodValidationPipe(deleteLinkSchema)) query: DeleteLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.goals.removeLink(u.orgId, goalId, query.linkId);
    if (!result) throw new NotFoundException("Link not found");
    return result;
  }
}
