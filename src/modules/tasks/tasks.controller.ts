import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
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
import { TasksService } from "./tasks.service";
import { TaskAnalyticsService } from "./task-analytics.service";
import { TaskSequencesService, isSequenceNotFound, isSequenceNoSteps } from "./task-sequences.service";
import {
  analyticsSchema,
  completeSchema,
  createSchema,
  listSchema,
  sequenceApplySchema,
  sequenceCreateSchema,
  sequenceListSchema,
  updateSchema,
  type AnalyticsInput,
  type CompleteInput,
  type CreateInput,
  type ListInput,
  type SequenceApplyInput,
  type SequenceCreateInput,
  type SequenceListInput,
  type UpdateInput,
} from "./dto/task.schemas";

@Controller("tasks")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly analytics: TaskAnalyticsService,
    private readonly sequences: TaskSequencesService,
  ) {}

  @Get()
  @RequirePermission("tasks:read")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.list(u, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("tasks:write")
  async create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const created = await this.tasks.create(u.orgId, u.userId, body);
    if (!created) throw new InternalServerErrorException("Failed to create task");
    return created;
  }

  @Get("analytics")
  @RequirePermission("tasks:read")
  getAnalytics(
    @Query(new ZodValidationPipe(analyticsSchema)) query: AnalyticsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.analytics(u.orgId, query);
  }

  @Get("sequences")
  @RequirePermission("tasks:read")
  listSequences(
    @Query(new ZodValidationPipe(sequenceListSchema)) query: SequenceListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.listSequences(u.orgId, query);
  }

  @Post("sequences")
  @HttpCode(201)
  @RequirePermission("tasks:write")
  createSequence(
    @Body(new ZodValidationPipe(sequenceCreateSchema)) body: SequenceCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.createSequence(u.orgId, u.userId, body);
  }

  @Delete("sequences/:sequenceId")
  @RequirePermission("tasks:write")
  async removeSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sequences.removeSequence(u.orgId, sequenceId);
    if (!result) throw new NotFoundException("Sequence not found");
    return result;
  }

  @Post("sequences/:sequenceId/apply")
  @HttpCode(201)
  @RequirePermission("tasks:write")
  async applySequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body(new ZodValidationPipe(sequenceApplySchema)) body: SequenceApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sequences.applySequence(u.orgId, u.userId, sequenceId, body);
    if (isSequenceNotFound(result)) throw new NotFoundException("Sequence not found");
    if (isSequenceNoSteps(result)) throw new BadRequestException("Sequence has no steps");
    return result;
  }

  @Patch(":taskId")
  @RequirePermission("tasks:write")
  async update(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.tasks.update(u.orgId, taskId, u.userId, body);
    if (!updated) throw new NotFoundException("Task not found");
    return updated;
  }

  @Delete(":taskId")
  @RequirePermission("tasks:write")
  async remove(
    @Param("taskId", ParseIntPipe) taskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.remove(u.orgId, taskId);
    if (!result) throw new NotFoundException("Task not found");
    return result;
  }

  @Post(":taskId/complete")
  @RequirePermission("tasks:write")
  async complete(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body(new ZodValidationPipe(completeSchema)) body: CompleteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.complete(u.orgId, taskId, body);
    if (!result) throw new NotFoundException("Task not found");
    return result;
  }
}
