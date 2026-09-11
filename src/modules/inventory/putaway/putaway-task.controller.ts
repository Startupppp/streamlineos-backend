import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PutawayTaskService } from "./putaway-task.service";
import { PutawayCompleteService } from "./putaway-complete.service";
import {
  completePutawaySchema,
  createPutawayTaskSchema,
  listPutawayTasksSchema,
  type CompletePutawayInput,
  type CreatePutawayTaskInput,
  type ListPutawayTasksInput,
} from "./dto/putaway.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  abandonPutawayTaskResponseSchema,
  cancelPutawayTaskResponseSchema,
  claimPutawayTaskResponseSchema,
  completePutawayResponseSchema,
  createPutawayTaskResponseSchema,
  getPutawayTaskResponseSchema,
  listPutawayTasksResponseSchema,
} from "./dto/putaway-response.schemas";

/**
 * B3 — the putaway workbench.
 *
 * Reading the queue is a stock read; walking a task relocates stock between two
 * bins, which is exactly what `inventory:stock:transfer` already authorises. No
 * new permission key: a key that means "may move stock from A to B" does not
 * become a different authority because the document above it is called a
 * putaway, and a new key would be unheld by every existing role until somebody
 * shipped a backfill.
 */
@RequireModule("inventory")
@Controller("inventory/putaway")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class PutawayTaskController {
  constructor(
    private readonly tasks: PutawayTaskService,
    private readonly completion: PutawayCompleteService,
  ) {}

  @Post("tasks")
  @ResponseSchema(createPutawayTaskResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Idempotent("inventory.putaway.task.create")
  createTask(
    @Body(new ZodValidationPipe(createPutawayTaskSchema)) body: CreatePutawayTaskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.createFromReceipt(u.orgId, u.userId, body);
  }

  @Get("tasks")
  @ResponseSchema(listPutawayTasksResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listTasks(
    @Query(new ZodValidationPipe(listPutawayTasksSchema)) query: ListPutawayTasksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.list(u.orgId, u.userId, query);
  }

  @Get("tasks/:taskId")
  @ResponseSchema(getPutawayTaskResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  getTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.get(u.orgId, u.userId, taskId);
  }

  /**
   * Claim, abandon and cancel take no idempotency key on purpose: each is a
   * single conditional update against the current state, so a repeat is the same
   * state rather than a second effect. A key would imply a fence they do not
   * need, and an unused key is worse than none because the client believes it is
   * protected.
   */
  @Post("tasks/:taskId/claim")
  @ResponseSchema(claimPutawayTaskResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Idempotent("inventory.putaway.task.claim")
  claimTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.claim(u.orgId, u.userId, taskId);
  }

  @Post("tasks/:taskId/abandon")
  @ResponseSchema(abandonPutawayTaskResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  abandonTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.abandon(u.orgId, u.userId, taskId);
  }

  @Post("tasks/:taskId/cancel")
  @ResponseSchema(cancelPutawayTaskResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  @Idempotent("inventory.putaway.task.cancel")
  cancelTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tasks.cancel(u.orgId, u.userId, taskId);
  }

  /** The one command here that moves stock, and the only one that takes a key. */
  @Post("tasks/:taskId/complete")
  @ResponseSchema(completePutawayResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  completeTask(
    @IdempotencyKey() idempotencyKey: string,
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body(new ZodValidationPipe(completePutawaySchema)) body: CompletePutawayInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.completion.complete(u.orgId, u.userId, taskId, body, idempotencyKey);
  }
}
