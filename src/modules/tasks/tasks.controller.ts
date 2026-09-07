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
import { AccessService } from "../access/access.service";
import { resolveTasksViewScope } from "./tasks-scope";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { TasksService } from "./tasks.service";
import { TaskSequencesService, isSequenceNotFound, isSequenceNoSteps } from "./task-sequences.service";
import { TaskAnalyticsService } from "./task-analytics.service";
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
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  taskAnalyticsSchema,
  taskRowSchema,
  taskSequenceApplySchema,
  taskSequenceRowSchema,
  taskSequencesListSchema,
  taskSequenceSuccessSchema,
  tasksListResponseSchema,
  taskSuccessSchema,
} from "./dto/tasks-response.schemas";
import { z } from "zod";

const sequenceIdParams = z.object({ sequenceId: z.coerce.number().int().positive() }).strict();
const taskIdParams = z.object({ taskId: z.coerce.number().int().positive() }).strict();

@Controller("tasks")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly sequences: TaskSequencesService,
    private readonly analytics: TaskAnalyticsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @ResponseSchema(tasksListResponseSchema)
  @RequirePermission("tasks:read")
  @Validate({ query: listSchema })
  list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.list(u, filters);
  }

  @Post()
  @ResponseSchema(taskRowSchema)
  @HttpCode(201)
  @RequirePermission("tasks:write")
  @Validate({ body: createSchema })
  async create(
    @Body() body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const created = await this.tasks.create(u.orgId, u.userId, body);
    if (!created) throw new InternalServerErrorException("Failed to create task");
    return created;
  }

  @Get("analytics")
  @ResponseSchema(taskAnalyticsSchema)
  @RequirePermission("tasks:read")
  @Validate({ query: analyticsSchema })
  async getAnalytics(
    @Query() query: AnalyticsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveTasksViewScope(this.access, u);
    return this.analytics.analytics(u.orgId, u.userId, scope, query);
  }

  @Get("sequences")
  @ResponseSchema(taskSequencesListSchema)
  @RequirePermission("tasks:read")
  @Validate({ query: sequenceListSchema })
  listSequences(
    @Query() query: SequenceListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.listSequences(u.orgId, query);
  }

  @Post("sequences")
  @ResponseSchema(taskSequenceRowSchema)
  @HttpCode(201)
  @RequirePermission("tasks:write")
  @Validate({ body: sequenceCreateSchema })
  createSequence(
    @Body() body: SequenceCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sequences.createSequence(u.orgId, u.userId, body);
  }

  @Delete("sequences/:sequenceId")
  @ResponseSchema(taskSequenceSuccessSchema)
  @RequirePermission("tasks:write")
  @Validate({ params: sequenceIdParams })
  async removeSequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sequences.removeSequence(u.orgId, sequenceId);
    if (!result) throw new NotFoundException("Sequence not found");
    return result;
  }

  @Post("sequences/:sequenceId/apply")
  @ResponseSchema(taskSequenceApplySchema)
  @HttpCode(201)
  @RequirePermission("tasks:write")
  @Validate({ params: sequenceIdParams, body: sequenceApplySchema })
  async applySequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body() body: SequenceApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sequences.applySequence(u.orgId, u.userId, sequenceId, body);
    if (isSequenceNotFound(result)) throw new NotFoundException("Sequence not found");
    if (isSequenceNoSteps(result)) throw new BadRequestException("Sequence has no steps");
    return result;
  }

  @Patch(":taskId")
  @ResponseSchema(taskRowSchema)
  @RequirePermission("tasks:write")
  @Validate({ params: taskIdParams, body: updateSchema })
  async update(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.tasks.update(u.orgId, taskId, u.userId, body);
    if (!updated) throw new NotFoundException("Task not found");
    return updated;
  }

  @Delete(":taskId")
  @ResponseSchema(taskSuccessSchema)
  @RequirePermission("tasks:write")
  @Validate({ params: taskIdParams })
  async remove(
    @Param("taskId", ParseIntPipe) taskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.remove(u.orgId, taskId);
    if (!result) throw new NotFoundException("Task not found");
    return result;
  }

  @Post(":taskId/complete")
  @ResponseSchema(taskRowSchema)
  @RequirePermission("tasks:write")
  @Validate({ params: taskIdParams, body: completeSchema })
  async complete(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() body: CompleteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.complete(u.orgId, taskId, body);
    if (!result) throw new NotFoundException("Task not found");
    return result;
  }
}
