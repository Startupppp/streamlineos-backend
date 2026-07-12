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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { VendorCreditsService } from "./vendor-credits.service";
import {
  createVendorCreditSchema,
  applyVendorCreditSchema,
  listVendorCreditsQuerySchema,
  type CreateVendorCreditInput,
  type ApplyVendorCreditInput,
  type ListVendorCreditsQuery,
} from "./dto/finance-ap.schemas";

@RequireModule("accounting")
@Controller("accounting/vendor-credits")
@UseGuards(JwtAuthGuard)
export class VendorCreditsController {
  constructor(private readonly service: VendorCreditsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:read")
  list(
    @Query(new ZodValidationPipe(listVendorCreditsQuerySchema)) query: ListVendorCreditsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listVendorCredits(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:create")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createVendorCreditSchema)) body: CreateVendorCreditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createVendorCredit(u.orgId, u.userId, body);
  }

  @Get(":vendorCreditId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:read")
  getOne(
    @Param("vendorCreditId", ParseIntPipe) vendorCreditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getVendorCredit(u.orgId, vendorCreditId);
  }

  @Post(":vendorCreditId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:manage")
  @HttpCode(200)
  postCredit(
    @Param("vendorCreditId", ParseIntPipe) vendorCreditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.postVendorCredit(u, vendorCreditId);
  }

  @Post(":vendorCreditId/apply")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:manage")
  @HttpCode(200)
  apply(
    @Param("vendorCreditId", ParseIntPipe) vendorCreditId: number,
    @Body(new ZodValidationPipe(applyVendorCreditSchema)) body: ApplyVendorCreditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.applyVendorCredit(u, vendorCreditId, body);
  }
}
