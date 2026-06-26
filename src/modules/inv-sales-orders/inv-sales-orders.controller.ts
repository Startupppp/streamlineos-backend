import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvSalesOrdersService } from "./inv-sales-orders.service";
import {
  listSoSchema,
  createSoSchema,
  shipSoSchema,
  type ListSoInput,
  type CreateSoInput,
  type ShipSoInput,
} from "./dto/inv-sales-orders.schemas";

@Controller("inventory/sales-orders")
@UseGuards(JwtAuthGuard)
export class InvSalesOrdersController {
  constructor(private readonly so: InvSalesOrdersService) {}

  @Get()
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:sales-orders")
  list(
    @Query(new ZodValidationPipe(listSoSchema)) filters: ListSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.so.listSos(u.orgId, filters);
  }

  @Get(":soId")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:sales-orders")
  get(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.so.getSo(u.orgId, soId);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("create", "inventory:sales-orders")
  create(
    @Body(new ZodValidationPipe(createSoSchema)) body: CreateSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.so.createSo(u.orgId, u.userId, body);
  }

  @Post(":soId/confirm")
  @UseGuards(AbilityGuard)
  @CheckAbility("confirm", "inventory:sales-orders")
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.so.confirmSo(u.orgId, soId, u.userId);
  }

  @Post(":soId/ship")
  @UseGuards(AbilityGuard)
  @CheckAbility("ship", "inventory:sales-orders")
  @HttpCode(HttpStatus.OK)
  ship(
    @Param("soId", ParseIntPipe) soId: number,
    @Body(new ZodValidationPipe(shipSoSchema)) body: ShipSoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.so.shipSo(u.orgId, soId, u.userId, body);
  }

  @Post(":soId/invoice")
  @UseGuards(AbilityGuard)
  @CheckAbility("invoice", "inventory:sales-orders")
  @HttpCode(HttpStatus.OK)
  invoice(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.so.invoiceSo(u.orgId, soId, u.userId);
  }

  @Get(":soId/atp")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:sales-orders")
  async getAtp(
    @Param("soId", ParseIntPipe) soId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const so = await this.so.getSo(u.orgId, soId);
    const variantIds = so.lines.map((l) => l.productVariantId);
    return this.so.getAtp(u.orgId, variantIds);
  }
}
