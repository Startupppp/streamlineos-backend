import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { ExchangeRatesService } from "./exchange-rates.service";
import {
  upsertExchangeRateSchema,
  listExchangeRatesSchema,
  type UpsertExchangeRateInput,
  type ListExchangeRatesQuery,
} from "./dto/finance-controls.schemas";

@RequireModule("accounting")
@Controller("accounting/exchange-rates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExchangeRatesController {
  constructor(private readonly svc: ExchangeRatesService) {}

  @Get()
  @RequirePermission("accounting:settings:read")
  list(
    @Query(new ZodValidationPipe(listExchangeRatesSchema)) query: ListExchangeRatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Post()
  @HttpCode(200)
  @RequirePermission("accounting:settings:manage")
  upsert(
    @Body(new ZodValidationPipe(upsertExchangeRateSchema)) body: UpsertExchangeRateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsert(u.orgId, u.userId, body);
  }
}
