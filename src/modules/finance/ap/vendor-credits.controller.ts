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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { VendorCreditsService } from "./vendor-credits.service";
import {
  createVendorCreditSchema,
  applyVendorCreditSchema,
  listVendorCreditsQuerySchema,
  type CreateVendorCreditInput,
  type ApplyVendorCreditInput,
  type ListVendorCreditsQuery,
} from "./dto/finance-ap.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  vendorCreditListResponseSchema,
  vendorCreditCreatedResponseSchema,
  vendorCreditDetailResponseSchema,
  vendorCreditPostResponseSchema,
  vendorCreditApplyResponseSchema,
} from "./dto/ap-response.schemas";

const vendorCreditIdParams = z.object({ vendorCreditId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/vendor-credits")
@UseGuards(JwtAuthGuard)
export class VendorCreditsController {
  constructor(private readonly service: VendorCreditsService) {}

  @Get()
  @ResponseSchema(vendorCreditListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:read")
  @Validate({ query: listVendorCreditsQuerySchema })
  list(
    @Query() query: ListVendorCreditsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listVendorCredits(u.orgId, query);
  }

  @Post()
  @ResponseSchema(vendorCreditCreatedResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:create")
  @HttpCode(201)
  @Validate({ body: createVendorCreditSchema })
  create(
    @Body() body: CreateVendorCreditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createVendorCredit(u.orgId, u.userId, body);
  }

  @Get(":vendorCreditId")
  @ResponseSchema(vendorCreditDetailResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:read")
  @Validate({ params: vendorCreditIdParams })
  getOne(
    @Param("vendorCreditId", ParseIntPipe) vendorCreditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getVendorCredit(u.orgId, vendorCreditId);
  }

  @Post(":vendorCreditId/post")
  @ResponseSchema(vendorCreditPostResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:manage")
  @HttpCode(200)
  @Validate({ params: vendorCreditIdParams })
  postCredit(
    @Param("vendorCreditId", ParseIntPipe) vendorCreditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.postVendorCredit(u, vendorCreditId);
  }

  @Post(":vendorCreditId/apply")
  @ResponseSchema(vendorCreditApplyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:vendor-credits:manage")
  @HttpCode(200)
  @Validate({ params: vendorCreditIdParams, body: applyVendorCreditSchema })
  apply(
    @Param("vendorCreditId", ParseIntPipe) vendorCreditId: number,
    @Body() body: ApplyVendorCreditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.applyVendorCredit(u, vendorCreditId, body);
  }
}
