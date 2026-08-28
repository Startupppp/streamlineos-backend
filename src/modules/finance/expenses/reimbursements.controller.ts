import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import { ReimbursementsService } from "./reimbursements.service";
import {
  batchListSchema,
  createBatchSchema,
  payBatchSchema,
  type BatchListInput,
  type CreateBatchInput,
  type PayBatchInput,
} from "./dto/finance-expenses.schemas";

@RequireModule("accounting")
@Controller("accounting/reimbursements")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReimbursementsController {
  constructor(private readonly reimbursements: ReimbursementsService) {}

  @Get()
  @RequirePermission("accounting:reimbursements:read")
  async list(
    @Query(new ZodValidationPipe(batchListSchema)) filters: BatchListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.listBatches(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("accounting:reimbursements:manage")
  @Idempotent("accounting.reimbursement-batch.create")
  async create(
    @Body(new ZodValidationPipe(createBatchSchema)) body: CreateBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.createBatch(u, body);
  }

  @Get(":batchId")
  @RequirePermission("accounting:reimbursements:read")
  async getOne(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.getBatch(u.orgId, batchId);
  }

  @Post(":batchId/approve")
  @Idempotent("finance.reimbursement.approve")
  @HttpCode(200)
  @RequirePermission("accounting:reimbursements:approve")
  async approve(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.approveBatch(u, batchId);
  }

  @Post(":batchId/pay")
  @HttpCode(200)
  @RequirePermission("accounting:reimbursements:manage")
  @Idempotent("accounting.reimbursement-batch.pay")
  async pay(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body(new ZodValidationPipe(payBatchSchema)) body: PayBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.payBatch(u, batchId, body);
  }
}
