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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TasksService, isSequenceNotFound, isSequenceNoSteps } from "./tasks.service";
import {
  analyticsSchema,
  completeSchema,
  createSchema,
  listSchema,
  overdueSchema,
  sequenceApplySchema,
  sequenceCreateSchema,
  sequenceListSchema,
  updateSchema,
  type AnalyticsInput,
  type CompleteInput,
  type CreateInput,
  type ListInput,
  type OverdueInput,
  type SequenceApplyInput,
  type SequenceCreateInput,
  type SequenceListInput,
  type UpdateInput,
} from "./dto/task.schemas";

@Controller("tasks")
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.list(u.orgId, u.userId, filters);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const created = await this.tasks.create(u.orgId, u.userId, body);
    if (!created) throw new InternalServerErrorException("Failed to create task");
    return created;
  }

  @Get("analytics")
  analytics(
    @Query(new ZodValidationPipe(analyticsSchema)) query: AnalyticsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.analytics(u.orgId, query);
  }

  @Get("my-queue")
  myQueue(@CurrentUser() u: CurrentUserContext) {
    return this.tasks.myQueue(u.orgId, u.userId);
  }

  @Get("overdue")
  overdue(
    @Query(new ZodValidationPipe(overdueSchema)) query: OverdueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.overdue(u.orgId, query.countOnly);
  }

  @Get("sequences")
  listSequences(
    @Query(new ZodValidationPipe(sequenceListSchema)) query: SequenceListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.listSequences(u.orgId, query);
  }

  @Post("sequences")
  @HttpCode(201)
  createSequence(
    @Body(new ZodValidationPipe(sequenceCreateSchema)) body: SequenceCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.createSequence(u.orgId, u.userId, body);
  }

  @Delete("sequences/:sequenceId")
  async removeSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.removeSequence(u.orgId, sequenceId);
    if (!result) throw new NotFoundException("Sequence not found");
    return result;
  }

  @Post("sequences/:sequenceId/apply")
  @HttpCode(201)
  async applySequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body(new ZodValidationPipe(sequenceApplySchema)) body: SequenceApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.applySequence(u.orgId, u.userId, sequenceId, body);
    if (isSequenceNotFound(result)) throw new NotFoundException("Sequence not found");
    if (isSequenceNoSteps(result)) throw new BadRequestException("Sequence has no steps");
    return result;
  }

  @Patch(":taskId")
  async update(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.tasks.update(u.orgId, taskId, body);
    if (!updated) throw new NotFoundException("Task not found");
    return updated;
  }

  @Delete(":taskId")
  async remove(
    @Param("taskId", ParseIntPipe) taskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.remove(u.orgId, taskId);
    if (!result) throw new NotFoundException("Task not found");
    return result;
  }

  @Post(":taskId/complete")
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
