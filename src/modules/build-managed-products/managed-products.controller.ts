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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ManagedProductsService } from "./managed-products.service";
import {
  createManagedProductSchema,
  listManagedProductsQuerySchema,
  updateManagedProductSchema,
  type CreateManagedProductInput,
  type ListManagedProductsQuery,
  type UpdateManagedProductInput,
} from "./dto/managed-products.schemas";

@RequireModule("build")
@Controller("build/managed-products")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ManagedProductsController {
  constructor(private readonly svc: ManagedProductsService) {}

  @Get()
  @RequirePermission("build:managed-products:view")
  listManagedProducts(
    @Query(new ZodValidationPipe(listManagedProductsQuerySchema)) query: ListManagedProductsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listManagedProducts(u.orgId, query);
  }

  @Get(":managedProductId")
  @RequirePermission("build:managed-products:view")
  getManagedProduct(
    @Param("managedProductId", ParseIntPipe) managedProductId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getManagedProduct(u.orgId, managedProductId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:managed-products:create")
  createManagedProduct(
    @Body(new ZodValidationPipe(createManagedProductSchema)) body: CreateManagedProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createManagedProduct(u.orgId, u.userId, body);
  }

  @Patch(":managedProductId")
  @RequirePermission("build:managed-products:update")
  updateManagedProduct(
    @Param("managedProductId", ParseIntPipe) managedProductId: number,
    @Body(new ZodValidationPipe(updateManagedProductSchema)) body: UpdateManagedProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateManagedProduct(u.orgId, u.userId, managedProductId, body);
  }

  @Delete(":managedProductId")
  @HttpCode(204)
  @RequirePermission("build:managed-products:delete")
  deleteManagedProduct(
    @Param("managedProductId", ParseIntPipe) managedProductId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteManagedProduct(u.orgId, u.userId, managedProductId);
  }
}
