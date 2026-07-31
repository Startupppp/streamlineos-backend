import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvProductsService } from "./inv-products.service";
import { resolveInvProductsScope } from "../stock-engine/inventory-scope";
import {
  listProductsSchema, createProductSchema, updateProductSchema,
  createVariantSchema, updateVariantSchema, createCategorySchema, createUomSchema, listVariantsSchema,
  updateCategorySchema, updateUomSchema,
  type ListProductsInput, type CreateProductInput, type UpdateProductInput,
  type CreateVariantInput, type UpdateVariantInput, type CreateCategoryInput, type CreateUomInput, type ListVariantsInput,
  type UpdateCategoryInput, type UpdateUomInput,
} from "./dto/inv-products.schemas";

@RequireModule("inventory")
@Controller("inventory/products")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvProductsController {
  constructor(
    private readonly products: InvProductsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  async list(
    @Query(new ZodValidationPipe(listProductsSchema)) filters: ListProductsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvProductsScope(this.access, u);
    return this.products.listProducts(u.orgId, filters, scope, u.userId);
  }

  @Get("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  listCategories(@CurrentUser() u: CurrentUserContext) {
    return this.products.listCategories(u.orgId);
  }

  @Post("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:create")
  createCategory(
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createCategory(u.orgId, body);
  }

  @Get("uom")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  listUom(@CurrentUser() u: CurrentUserContext) {
    return this.products.listUom(u.orgId);
  }

  @Post("uom")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:create")
  createUom(
    @Body(new ZodValidationPipe(createUomSchema)) body: CreateUomInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createUom(u.orgId, body);
  }

  @Patch("categories/:categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  updateCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.updateCategory(u.orgId, categoryId, body);
  }

  @Patch("uom/:uomId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  updateUom(
    @Param("uomId", ParseIntPipe) uomId: number,
    @Body(new ZodValidationPipe(updateUomSchema)) body: UpdateUomInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.updateUom(u.orgId, uomId, body);
  }

  @Get("variants")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  listVariants(
    @Query(new ZodValidationPipe(listVariantsSchema)) filters: ListVariantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.listVariants(u.orgId, filters);
  }

  @Post(":productId/archive")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @HttpCode(HttpStatus.OK)
  archive(
    @Param("productId", ParseIntPipe) productId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.archiveProduct(u.orgId, productId, u.userId);
  }

  @Post(":productId/restore")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @HttpCode(HttpStatus.OK)
  restore(
    @Param("productId", ParseIntPipe) productId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.restoreProduct(u.orgId, productId, u.userId);
  }

  @Get(":productId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  get(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    return this.products.getProduct(u.orgId, productId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:create")
  create(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createProduct(u.orgId, u.userId, body);
  }

  @Patch(":productId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  update(
    @Param("productId", ParseIntPipe) productId: number,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.updateProduct(u.orgId, productId, body);
  }

  @Delete(":productId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:delete")
  async delete(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    await this.products.deleteProduct(u.orgId, productId);
  }

  @Post(":productId/variants")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  createVariant(
    @Param("productId", ParseIntPipe) productId: number,
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createVariant(u.orgId, productId, body);
  }

  @Patch(":productId/variants/:variantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  updateVariant(
    @Param("productId", ParseIntPipe) _: number,
    @Param("variantId", ParseIntPipe) variantId: number,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.updateVariant(u.orgId, variantId, body);
  }
}
