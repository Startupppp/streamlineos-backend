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

@RequireModule("projects")
@Controller("goals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  @RequirePermission("projects:goals:view")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.list(u, filters);
  }

  @Post()
  @RequirePermission("projects:goals:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.create(u.orgId, u.userId, body);
  }

  @Get("stats")
  @RequirePermission("projects:goals:view")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.goals.getStats(u.orgId);
  }

  @Get(":goalId")
  @RequirePermission("projects:goals:view")
  async get(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const goal = await this.goals.getGoal(u.orgId, goalId);
    if (!goal) throw new NotFoundException("Goal not found");
    return goal;
  }

  @Patch(":goalId")
  @RequirePermission("projects:goals:manage")
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
  @RequirePermission("projects:goals:manage")
  @HttpCode(204)
  async remove(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.goals.remove(u.orgId, goalId);
    if (!result) throw new NotFoundException("Goal not found");
  }

  @Post(":goalId/check-in")
  @RequirePermission("projects:goals:manage")
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
  @RequirePermission("projects:goals:view")
  getLinks(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.getLinks(u.orgId, goalId);
  }

  @Post(":goalId/links")
  @RequirePermission("projects:goals:manage")
  @HttpCode(201)
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
  @RequirePermission("projects:goals:manage")
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
