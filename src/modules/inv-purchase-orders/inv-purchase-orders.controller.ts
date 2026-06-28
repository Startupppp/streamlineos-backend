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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvPurchaseOrdersService } from "./inv-purchase-orders.service";
import {
  listPoSchema,
  createPoSchema,
  createGrnSchema,
  type ListPoInput,
  type CreatePoInput,
  type CreateGrnInput,
} from "./dto/inv-purchase-orders.schemas";

@Controller("inventory/purchase-orders")
@UseGuards(JwtAuthGuard)
export class InvPurchaseOrdersController {
  constructor(private readonly pos: InvPurchaseOrdersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  list(
    @Query(new ZodValidationPipe(listPoSchema)) filters: ListPoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.listPos(u.orgId, filters);
  }

  @Get(":poId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  get(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.getPo(u.orgId, poId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:create")
  create(
    @Body(new ZodValidationPipe(createPoSchema)) body: CreatePoInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.createPo(u.orgId, u.userId, body);
  }

  @Post(":poId/send")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:approve")
  @HttpCode(HttpStatus.OK)
  send(
    @Param("poId", ParseIntPipe) poId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.sendPo(u.orgId, poId);
  }

  @Post(":poId/receive")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  receiveGoods(
    @Param("poId", ParseIntPipe) poId: number,
    @Body(new ZodValidationPipe(createGrnSchema)) body: CreateGrnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pos.receiveGoods(u.orgId, poId, u.userId, body);
  }
}
