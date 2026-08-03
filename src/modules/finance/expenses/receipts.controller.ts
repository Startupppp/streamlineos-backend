import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
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
import { ReceiptsService } from "./receipts.service";
import {
  receiptListSchema,
  patchReceiptSchema,
  type ReceiptListInput,
  type PatchReceiptInput,
} from "./dto/finance-expenses.schemas";

@RequireModule("accounting")
@Controller("accounting/expenses/receipts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  @RequirePermission("accounting:reimbursements:read")
  async list(
    @Query(new ZodValidationPipe(receiptListSchema)) filters: ReceiptListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.listReceiptInbox(u.orgId, filters);
  }

  @Patch(":expenseId")
  @RequirePermission("accounting:reimbursements:manage")
  async patchMetadata(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body(new ZodValidationPipe(patchReceiptSchema)) body: PatchReceiptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.patchReceiptMetadata(u.orgId, u.userId, expenseId, body);
  }
}
