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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const runIdParams = z.object({ runId: z.coerce.number().int().positive() }).strict();
const runIditemIdParams = z.object({ runId: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listPaymentRunsQuerySchema })
  list(
    @Query() query: ListPaymentRunsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listRuns(u.orgId, query);
  }

  @Get(":runId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:read")
  @Validate({ params: runIdParams })
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
  @Validate({ body: createPaymentRunSchema })
  create(
    @Body() body: CreatePaymentRunInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createRun(u.orgId, u.userId, body);
  }

  @Post(":runId/approve")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:approve")
  @HttpCode(200)
  @Idempotent("accounting.payment-run.approve")
  @Validate({ params: runIdParams })
  approve(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approveRun(u, runId);
  }

  @Post(":runId/execute")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:manage")
  @HttpCode(200)
  @Idempotent("accounting.payment-run.execute")
  @Validate({ params: runIdParams })
  execute(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.executor.executeRun(u, runId);
  }

  @Post(":runId/cancel")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:manage")
  @HttpCode(200)
  @Validate({ params: runIdParams })
  cancel(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancelRun(u.orgId, u.userId, runId);
  }

  @Patch(":runId/items/:itemId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payment-runs:manage")
  @Validate({ params: runIditemIdParams, body: updatePaymentRunItemSchema })
  updateItem(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: UpdatePaymentRunItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateRunItem(u.orgId, u.userId, runId, itemId, body);
  }
}
