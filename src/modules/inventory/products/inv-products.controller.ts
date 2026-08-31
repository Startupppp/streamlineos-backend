import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvProductCrudService } from "./inv-product-crud.service";
import { InvProductCatalogService } from "./inv-product-catalog.service";
import { resolveInvProductsScope } from "../stock-engine/inventory-scope";
import {
  listProductsSchema, createProductSchema, updateProductSchema,
  createVariantSchema, updateVariantSchema, createCategorySchema, createUomSchema, listVariantsSchema,
  updateCategorySchema, updateUomSchema,
  type ListProductsInput, type CreateProductInput, type UpdateProductInput,
  type CreateVariantInput, type UpdateVariantInput, type CreateCategoryInput, type CreateUomInput, type ListVariantsInput,
  type UpdateCategoryInput, type UpdateUomInput,
} from "./dto/inv-products.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const categoryIdParams = z.object({ categoryId: z.coerce.number().int().positive() }).strict();
const uomIdParams = z.object({ uomId: z.coerce.number().int().positive() }).strict();
const productIdParams = z.object({ productId: z.coerce.number().int().positive() }).strict();
const productIdvariantIdParams = z.object({ productId: z.coerce.number().int().positive(), variantId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/products")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvProductsController {
  constructor(
    private readonly crud: InvProductCrudService,
    private readonly catalog: InvProductCatalogService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  @Validate({ query: listProductsSchema })
  async list(
    @Query() filters: ListProductsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvProductsScope(this.access, u);
    return this.crud.listProducts(u.orgId, filters, scope, u.userId);
  }

  @Get("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  listCategories(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listCategories(u.orgId);
  }

  @Post("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:create")
  @Validate({ body: createCategorySchema })
  createCategory(
    @Body() body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createCategory(u.orgId, body);
  }

  @Get("uom")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  listUom(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listUom(u.orgId);
  }

  @Post("uom")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:create")
  @Validate({ body: createUomSchema })
  createUom(
    @Body() body: CreateUomInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createUom(u.orgId, body);
  }

  @Patch("categories/:categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @Validate({ params: categoryIdParams, body: updateCategorySchema })
  updateCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body() body: UpdateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateCategory(u.orgId, categoryId, body);
  }

  @Patch("uom/:uomId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @Validate({ params: uomIdParams, body: updateUomSchema })
  updateUom(
    @Param("uomId", ParseIntPipe) uomId: number,
    @Body() body: UpdateUomInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateUom(u.orgId, uomId, body);
  }

  @Get("variants")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  @Validate({ query: listVariantsSchema })
  listVariants(
    @Query() filters: ListVariantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.listVariants(u.orgId, filters);
  }

  @Post(":productId/archive")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: productIdParams })
  archive(
    @Param("productId", ParseIntPipe) productId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.archiveProduct(u.orgId, productId, u.userId);
  }

  @Post(":productId/restore")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: productIdParams })
  restore(
    @Param("productId", ParseIntPipe) productId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.restoreProduct(u.orgId, productId, u.userId);
  }

  @Get(":productId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  @Validate({ params: productIdParams })
  get(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    return this.crud.getProduct(u.orgId, productId, u.userId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:create")
  @Validate({ body: createProductSchema })
  create(
    @Body() body: CreateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.createProduct(u.orgId, u.userId, body);
  }

  @Patch(":productId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @Validate({ params: productIdParams, body: updateProductSchema })
  update(
    @Param("productId", ParseIntPipe) productId: number,
    @Body() body: UpdateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.updateProduct(u.orgId, productId, body);
  }

  @Delete(":productId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:delete")
  @Validate({ params: productIdParams })
  async delete(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    await this.crud.deleteProduct(u.orgId, productId);
  }

  @Post(":productId/variants")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @Validate({ params: productIdParams, body: createVariantSchema })
  createVariant(
    @Param("productId", ParseIntPipe) productId: number,
    @Body() body: CreateVariantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createVariant(u.orgId, productId, body);
  }

  @Patch(":productId/variants/:variantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:update")
  @Validate({ params: productIdvariantIdParams, body: updateVariantSchema })
  updateVariant(
    @Param("productId", ParseIntPipe) _: number,
    @Param("variantId", ParseIntPipe) variantId: number,
    @Body() body: UpdateVariantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateVariant(u.orgId, variantId, body);
  }
}
