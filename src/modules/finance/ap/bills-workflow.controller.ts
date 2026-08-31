import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { BillsWorkflowService } from "./bills-workflow.service";
import {
  billApprovalNoteSchema,
  billCancelSchema,
  type BillApprovalNote,
  type BillCancel,
} from "./dto/finance-ap.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const billIdParams = z.object({ billId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/purchase-bills")
@UseGuards(JwtAuthGuard)
export class BillsWorkflowController {
  constructor(private readonly service: BillsWorkflowService) {}

  @Post(":billId/submit-approval")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  @HttpCode(200)
  @Idempotent("accounting.bill.submit-approval")
  @Validate({ params: billIdParams, body: billApprovalNoteSchema })
  submitForApproval(
    @Param("billId", ParseIntPipe) billId: number,
    @Body() body: BillApprovalNote,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.submitForApproval(u, billId, body);
  }

  @Post(":billId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:approve")
  @HttpCode(200)
  @Idempotent("accounting.bill.approve")
  @Validate({ params: billIdParams })
  approveBill(
    @Param("billId", ParseIntPipe) billId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approveBill(u, billId);
  }

  @Post(":billId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  @HttpCode(200)
  @Validate({ params: billIdParams, body: billCancelSchema })
  cancelBill(
    @Param("billId", ParseIntPipe) billId: number,
    @Body() body: BillCancel,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancelBill(u, billId, body);
  }
}
