import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
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
import { actingMembershipId } from "../../../common/auth/principal";
import { ManagedProductsService } from "./managed-products.service";
import {
  createManagedProductSchema,
  listManagedProductsQuerySchema,
  updateManagedProductSchema,
  type CreateManagedProductInput,
  type ListManagedProductsQuery,
  type UpdateManagedProductInput,
} from "./dto/managed-products.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { managedProductInsightsSchema, managedProductRowSchema, managedProductPageSchema } from "./dto/managed-products-response.schemas";

const managedProductIdParams = z.object({ managedProductId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/managed-products")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ManagedProductsController {
  constructor(private readonly svc: ManagedProductsService) {}

  @Get()
  @RequirePermission("build:managed-products:view")
  @ResponseSchema(managedProductPageSchema)
  @Validate({ query: listManagedProductsQuerySchema })
  listManagedProducts(
    @Query() query: ListManagedProductsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listManagedProducts(u.orgId, query, actingMembershipId(u.principal));
  }

  @Get(":managedProductId")
  @RequirePermission("build:managed-products:view")
  @ResponseSchema(managedProductRowSchema)
  @Validate({ params: managedProductIdParams })
  getManagedProduct(
    @Param("managedProductId", ParseIntPipe) managedProductId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getManagedProduct(u.orgId, managedProductId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:managed-products:create")
  @ResponseSchema(managedProductRowSchema)
  @Validate({ body: createManagedProductSchema })
  createManagedProduct(
    @Body() body: CreateManagedProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createManagedProduct(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @Patch(":managedProductId")
  @RequirePermission("build:managed-products:update")
  @ResponseSchema(managedProductRowSchema)
  @Validate({ params: managedProductIdParams, body: updateManagedProductSchema })
  updateManagedProduct(
    @Param("managedProductId", ParseIntPipe) managedProductId: number,
    @Body() body: UpdateManagedProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateManagedProduct(u.orgId, u.userId, managedProductId, body);
  }

  @Get(":managedProductId/insights")
  @RequirePermission("build:managed-products:view")
  @ResponseSchema(managedProductInsightsSchema)
  @Validate({ params: managedProductIdParams })
  getProductInsights(
    @Param("managedProductId", ParseIntPipe) managedProductId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getProductInsights(u.orgId, managedProductId);
  }

  @Delete(":managedProductId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("build:managed-products:delete")
  @Validate({ params: managedProductIdParams })
  deleteManagedProduct(
    @Param("managedProductId", ParseIntPipe) managedProductId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteManagedProduct(u.orgId, u.userId, managedProductId);
  }
}
