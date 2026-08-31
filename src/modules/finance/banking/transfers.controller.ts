import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TransfersService } from "./transfers.service";
import {
  createBankTransferSchema,
  transfersQuerySchema,
  type CreateBankTransferInput,
  type TransfersQuery,
} from "./dto/transfers.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("finance/transfers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TransfersController {
  constructor(private readonly service: TransfersService) {}

  @Get()
  @RequirePermission("accounting:banking:read")
  @Validate({ query: transfersQuerySchema })
  list(
    @Query() query: TransfersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u, query);
  }

  @Post()
  @Idempotent("accounting.bank-transfer.create")
  @HttpCode(201)
  @RequirePermission("accounting:banking:manage")
  @Validate({ body: createBankTransferSchema })
  create(
    @Body() body: CreateBankTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }
}
