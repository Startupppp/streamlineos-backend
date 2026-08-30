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
import { TasksService, isSequenceNotFound, isSequenceNoSteps } from "./tasks.service";
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
import { z } from "zod";

const sequenceIdParams = z.object({ sequenceId: z.coerce.number().int().positive() }).strict();
const taskIdParams = z.object({ taskId: z.coerce.number().int().positive() }).strict();
@Controller("tasks")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermission("tasks:read")
  @Validate({ query: listSchema })
  list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.list(u, filters);
  }

  @Post()
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
  @RequirePermission("tasks:read")
  @Validate({ query: analyticsSchema })
  analytics(
    @Query() query: AnalyticsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.analytics(u.orgId, query);
  }

  @Get("sequences")
  @RequirePermission("tasks:read")
  @Validate({ query: sequenceListSchema })
  listSequences(
    @Query() query: SequenceListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.listSequences(u.orgId, query);
  }

  @Post("sequences")
  @HttpCode(201)
  @RequirePermission("tasks:write")
  @Validate({ body: sequenceCreateSchema })
  createSequence(
    @Body() body: SequenceCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.createSequence(u.orgId, u.userId, body);
  }

  @Delete("sequences/:sequenceId")
  @RequirePermission("tasks:write")
  @Validate({ params: sequenceIdParams })
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
  @RequirePermission("tasks:write")
  @Validate({ params: sequenceIdParams, body: sequenceApplySchema })
  async applySequence(
    @Param("sequenceId", ParseIntPipe) sequenceId: number,
    @Body() body: SequenceApplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.tasks.applySequence(u.orgId, u.userId, sequenceId, body);
    if (isSequenceNotFound(result)) throw new NotFoundException("Sequence not found");
    if (isSequenceNoSteps(result)) throw new BadRequestException("Sequence has no steps");
    return result;
  }

  @Patch(":taskId")
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
