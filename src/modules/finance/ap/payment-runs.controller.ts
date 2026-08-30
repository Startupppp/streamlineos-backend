import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PaymentRunsService } from "./payment-runs.service";
import { PaymentRunExecutorService } from "./payment-run-executor.service";
import {
  createPaymentRunSchema,
  updatePaymentRunItemSchema,
  listPaymentRunsQuerySchema,
  type CreatePaymentRunInput,
  type UpdatePaymentRunItemInput,
  type ListPaymentRunsQuery,
} from "./dto/finance-ap.schemas";

@RequireModule("accounting")
@Controller("accounting/payment-runs")
@UseGuards(JwtAuthGuard)
export class PaymentRunsController {
  constructor(
    private readonly service: PaymentRunsService,
    private readonly executor: PaymentRunExecutorService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:read")
  list(
    @Query(new ZodValidationPipe(listPaymentRunsQuerySchema)) query: ListPaymentRunsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listRuns(u.orgId, query);
  }

  @Get(":runId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:read")
  getOne(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getRun(u.orgId, runId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:manage")
  @HttpCode(201)
  @Idempotent("accounting.payment-run.create")
  create(
    @Body(new ZodValidationPipe(createPaymentRunSchema)) body: CreatePaymentRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createRun(u.orgId, u.userId, body);
  }

  @Post(":runId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:approve")
  @HttpCode(200)
  @Idempotent("accounting.payment-run.approve")
  approve(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approveRun(u, runId);
  }

  @Post(":runId/execute")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:manage")
  @HttpCode(200)
  @Idempotent("accounting.payment-run.execute")
  execute(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.executor.executeRun(u, runId);
  }

  @Post(":runId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:manage")
  @HttpCode(200)
  cancel(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancelRun(u.orgId, u.userId, runId);
  }

  @Patch(":runId/items/:itemId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:manage")
  updateItem(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(updatePaymentRunItemSchema)) body: UpdatePaymentRunItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateRunItem(u.orgId, u.userId, runId, itemId, body);
  }
}
