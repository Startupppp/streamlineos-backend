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
import { CustomerReturnsService } from "./customer-returns.service";
import {
  listReturnsSchema, createCustomerReturnSchema, postCustomerReturnSchema,
  type ListReturnsInput, type CreateCustomerReturnInput, type PostCustomerReturnInput,
  inspectReturnLineSchema,
  type InspectReturnLineInput,
  approveReturnSchema,
  type ApproveReturnInput,
} from "./dto/inv-returns.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

const returnIdParams = z.object({ returnId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/customer-returns")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CustomerReturnsController {
  constructor(private readonly service: CustomerReturnsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Validate({ query: listReturnsSchema })
  list(
    @Query() filters: ListReturnsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, u.userId, filters);
  }

  @Get(":returnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Validate({ params: returnIdParams })
  get(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.get(u.orgId, returnId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Idempotent("inventory.customer-return.create")
  @Validate({ body: createCustomerReturnSchema })
  create(
    @Body() body: CreateCustomerReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  /**
   * INV-209. Records the disposition decided after opening the box, with who
   * decided it and when. Posting refuses until every line has one.
   */
  @Post(":returnId/inspect")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Validate({ params: returnIdParams, body: inspectReturnLineSchema })
  inspectLine(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body() body: InspectReturnLineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.inspectLine(u.orgId, u.userId, returnId, body);
  }

  /**
   * B9, item 1. The sign-off between the inspection and the ledger. No
   * idempotency key: this writes no stock, and the compare-and-set on DRAFT
   * makes a retry a no-op on its own.
   */
  @Post(":returnId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Idempotent("inventory.customer-return.approve")
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
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams, body: postCustomerReturnSchema })
  post(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body() body: PostCustomerReturnInput,
    @IdempotencyKey() idempotencyKeyHeader: string,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.service.post(u.orgId, returnId, u.userId, idempotencyKeyHeader, body);
  }

  @Post(":returnId/cancel")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:customer-returns:manage")
  @Idempotent("inventory.customer-return.cancel")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: returnIdParams })
  cancel(
    @Param("returnId", ParseIntPipe) returnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.cancel(u.orgId, returnId);
  }
}
