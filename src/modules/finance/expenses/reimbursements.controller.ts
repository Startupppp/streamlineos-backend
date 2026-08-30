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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const batchIdParams = z.object({ batchId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/reimbursements")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReimbursementsController {
  constructor(private readonly reimbursements: ReimbursementsService) {}

  @Get()
  @RequirePermission("accounting:reimbursements:read")
  @Validate({ query: batchListSchema })
  async list(
    @Query() filters: BatchListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.listBatches(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("accounting:reimbursements:manage")
  @Idempotent("accounting.reimbursement-batch.create")
  @Validate({ body: createBatchSchema })
  async create(
    @Body() body: CreateBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.createBatch(u, body);
  }

  @Get(":batchId")
  @RequirePermission("accounting:reimbursements:read")
  @Validate({ params: batchIdParams })
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
  @Validate({ params: batchIdParams })
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
  @Validate({ params: batchIdParams, body: payBatchSchema })
  async pay(
    @Param("batchId", ParseIntPipe) batchId: number,
    @Body() body: PayBatchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.payBatch(u, batchId, body);
  }
}
