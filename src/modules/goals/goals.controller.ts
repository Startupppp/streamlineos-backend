import {
  BadRequestException,
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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
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
  createKeyResultSchema,
  createLinkSchema,
  createSchema,
  deleteLinkSchema,
  listSchema,
  updateKeyResultSchema,
  updateSchema,
  type CheckInInput,
  type CreateInput,
  type CreateKeyResultInput,
  type CreateLinkInput,
  type DeleteLinkInput,
  type ListInput,
  type UpdateInput,
  type UpdateKeyResultInput,
} from "./dto/goal.schemas";

@Controller("goals")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  @CheckAbility("view", "projects:goals")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.list(u.orgId, filters);
  }

  @Post()
  @CheckAbility("manage", "projects:goals")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.create(u.orgId, u.userId, body);
  }

  @Get("stats")
  @CheckAbility("view", "projects:goals")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.goals.getStats(u.orgId);
  }

  @Patch("key-results/:keyResultId")
  @CheckAbility("manage", "projects:goals")
  async updateKeyResult(
    @Param("keyResultId", ParseIntPipe) keyResultId: number,
    @Body(new ZodValidationPipe(updateKeyResultSchema)) body: UpdateKeyResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.goals.updateKeyResult(u.orgId, keyResultId, body);
    if (!updated) throw new NotFoundException("Key result not found");
    return updated;
  }

  @Delete("key-results/:keyResultId")
  @CheckAbility("manage", "projects:goals")
  async removeKeyResult(
    @Param("keyResultId", ParseIntPipe) keyResultId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.goals.removeKeyResult(u.orgId, keyResultId);
    if (!result) throw new NotFoundException("Key result not found");
    return result;
  }

  @Get(":goalId")
  @CheckAbility("view", "projects:goals")
  async get(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const goal = await this.goals.getGoal(u.orgId, goalId);
    if (!goal) throw new NotFoundException("Goal not found");
    return goal;
  }

  @Patch(":goalId")
  @CheckAbility("manage", "projects:goals")
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
  @CheckAbility("manage", "projects:goals")
  async remove(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.goals.remove(u.orgId, goalId);
    if (!result) throw new NotFoundException("Goal not found");
    return result;
  }

  @Post(":goalId/check-in")
  @CheckAbility("manage", "projects:goals")
  async checkIn(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body(new ZodValidationPipe(checkInSchema)) body: CheckInInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const goal = await this.goals.checkIn(u.orgId, u.userId, goalId, body);
    if (!goal) throw new NotFoundException("Key result not found");
    return goal;
  }

  @Get(":goalId/key-results")
  @CheckAbility("view", "projects:goals")
  listKeyResults(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.listKeyResults(u.orgId, goalId);
  }

  @Post(":goalId/key-results")
  @CheckAbility("manage", "projects:goals")
  @HttpCode(201)
  async createKeyResult(
    @Param("goalId", ParseIntPipe) goalId: number,
    @Body(new ZodValidationPipe(createKeyResultSchema)) body: CreateKeyResultInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const keyResult = await this.goals.createKeyResult(u.orgId, goalId, body);
    if (!keyResult) throw new NotFoundException("Goal not found");
    return keyResult;
  }

  @Get(":goalId/links")
  @CheckAbility("view", "projects:goals")
  getLinks(
    @Param("goalId", ParseIntPipe) goalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.goals.getLinks(u.orgId, goalId);
  }

  @Post(":goalId/links")
  @CheckAbility("manage", "projects:goals")
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
  @CheckAbility("manage", "projects:goals")
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
