import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TransfersService } from "./transfers.service";
import {
  createBankTransferSchema,
  transfersQuerySchema,
  type CreateBankTransferInput,
  type TransfersQuery,
} from "./dto/transfers.schemas";

@RequireModule("accounting")
@Controller("finance/transfers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TransfersController {
  constructor(private readonly service: TransfersService) {}

  @Get()
  @RequirePermission("accounting:banking:read")
  list(
    @Query(new ZodValidationPipe(transfersQuerySchema)) query: TransfersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u, query);
  }

  @Post()
  @RequirePermission("accounting:banking:manage")
  create(
    @Body(new ZodValidationPipe(createBankTransferSchema)) body: CreateBankTransferInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }
}
