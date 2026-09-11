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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { VendorReturnsService } from "./vendor-returns.service";
import {
  listReturnsSchema, createVendorReturnSchema, postVendorReturnSchema,
  type ListReturnsInput, type CreateVendorReturnInput, type PostVendorReturnInput,
  approveReturnSchema, type ApproveReturnInput,
} from "./dto/inv-returns.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  listVendorReturnsResponseSchema,
  getVendorReturnResponseSchema,
} from "./dto/returns-response.schemas";

const returnIdParams = z.object({ returnId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/vendor-returns")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class VendorReturnsController {
  constructor(private readonly service: VendorReturnsService) {}

  @Get()
  @ResponseSchema(listVendorReturnsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Validate({ query: listReturnsSchema })
  list(
    @Query() filters: ListReturnsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, u.userId, filters);
  }

  @Get(":returnId")
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Validate({ params: returnIdParams })
  get(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.get(u.orgId, u.userId, returnId);
  }

  @Post()
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Idempotent("inventory.vendor-return.create")
  @Validate({ body: createVendorReturnSchema })
  create(
    @Body() body: CreateVendorReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  /** B9, item 1. The sign-off before the goods leave. See the customer half. */
  @Post(":returnId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Idempotent("inventory.vendor-return.approve")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams, body: approveReturnSchema })
  approve(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body() body: ApproveReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approve(u.orgId, returnId, u.userId, body);
  }

  @Post(":returnId/post")
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams, body: postVendorReturnSchema })
  post(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body() body: PostVendorReturnInput,
    @IdempotencyKey() idempotencyKeyHeader: string,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.service.post(u.orgId, returnId, u.userId, idempotencyKeyHeader, body);
  }

  @Post(":returnId/cancel")
  @BodylessAction()
  @ResponseSchema(getVendorReturnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:vendor-returns:manage")
  @Idempotent("inventory.vendor-return.cancel")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams })
  cancel(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancel(u.orgId, u.userId, returnId);
  }
}
