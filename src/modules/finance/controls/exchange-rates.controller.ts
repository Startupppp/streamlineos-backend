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
import { ExchangeRatesService } from "./exchange-rates.service";
import {
  upsertExchangeRateSchema,
  listExchangeRatesSchema,
  type UpsertExchangeRateInput,
  type ListExchangeRatesQuery,
} from "./dto/finance-controls.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { exchangeRateListResponseSchema, exchangeRateSchema } from "./dto/controls-response.schemas";

@RequireModule("accounting")
@Controller("accounting/exchange-rates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExchangeRatesController {
  constructor(private readonly svc: ExchangeRatesService) {}

  @Get()
  @ResponseSchema(exchangeRateListResponseSchema)
  @RequirePermission("accounting:settings:read")
  @Validate({ query: listExchangeRatesSchema })
  list(
    @Query() query: ListExchangeRatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(exchangeRateSchema)
  @HttpCode(200)
  @RequirePermission("accounting:settings:manage")
  @Validate({ body: upsertExchangeRateSchema })
  upsert(
    @Body() body: UpsertExchangeRateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsert(u.orgId, u.userId, body);
  }
}
