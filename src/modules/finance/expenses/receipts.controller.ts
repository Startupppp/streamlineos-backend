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
import { ReceiptsService } from "./receipts.service";
import {
  receiptListSchema,
  patchReceiptSchema,
  type ReceiptListInput,
  type PatchReceiptInput,
} from "./dto/finance-expenses.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { receiptInboxListResponseSchema, successSchema } from "./dto/expenses-response.schemas";

const expenseIdParams = z.object({ expenseId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/expenses/receipts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  @ResponseSchema(receiptInboxListResponseSchema)
  @RequirePermission("accounting:reimbursements:read")
  @Validate({ query: receiptListSchema })
  async list(
    @Query() filters: ReceiptListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.listReceiptInbox(u.orgId, filters);
  }

  @Patch(":expenseId")
  @ResponseSchema(successSchema)
  @RequirePermission("accounting:reimbursements:manage")
  @Validate({ params: expenseIdParams, body: patchReceiptSchema })
  async patchMetadata(
    @Param("expenseId", ParseIntPipe) expenseId: number,
    @Body() body: PatchReceiptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receipts.patchReceiptMetadata(u.orgId, u.userId, expenseId, body);
  }
}
