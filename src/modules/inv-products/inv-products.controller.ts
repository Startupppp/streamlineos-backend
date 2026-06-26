import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvProductsService } from "./inv-products.service";
import {
  listProductsSchema, createProductSchema, updateProductSchema,
  createVariantSchema, updateVariantSchema, createCategorySchema, createUomSchema,
  type ListProductsInput, type CreateProductInput, type UpdateProductInput,
  type CreateVariantInput, type UpdateVariantInput, type CreateCategoryInput, type CreateUomInput,
} from "./dto/inv-products.schemas";

@Controller("inventory/products")
@UseGuards(JwtAuthGuard)
export class InvProductsController {
  constructor(private readonly products: InvProductsService) {}

  @Get()
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:products")
  list(
    @Query(new ZodValidationPipe(listProductsSchema)) filters: ListProductsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.listProducts(u.orgId, filters);
  }

  @Get("categories")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:products")
  listCategories(@CurrentUser() u: CurrentUserContext) {
    return this.products.listCategories(u.orgId);
  }

  @Post("categories")
  @UseGuards(AbilityGuard)
  @CheckAbility("create", "inventory:products")
  createCategory(
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createCategory(u.orgId, body);
  }

  @Get("uom")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:products")
  listUom(@CurrentUser() u: CurrentUserContext) {
    return this.products.listUom(u.orgId);
  }

  @Post("uom")
  @UseGuards(AbilityGuard)
  @CheckAbility("create", "inventory:products")
  createUom(
    @Body(new ZodValidationPipe(createUomSchema)) body: CreateUomInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createUom(u.orgId, body);
  }

  @Get(":productId")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:products")
  get(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    return this.products.getProduct(u.orgId, productId);
  }

  @Post()
  @UseGuards(AbilityGuard)
  @CheckAbility("create", "inventory:products")
  create(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createProduct(u.orgId, u.userId, body);
  }

  @Patch(":productId")
  @UseGuards(AbilityGuard)
  @CheckAbility("update", "inventory:products")
  update(
    @Param("productId", ParseIntPipe) productId: number,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.updateProduct(u.orgId, productId, body);
  }

  @Delete(":productId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AbilityGuard)
  @CheckAbility("delete", "inventory:products")
  async delete(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    await this.products.deleteProduct(u.orgId, productId);
  }

  @Post(":productId/variants")
  @UseGuards(AbilityGuard)
  @CheckAbility("update", "inventory:products")
  createVariant(
    @Param("productId", ParseIntPipe) productId: number,
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createVariant(u.orgId, productId, body);
  }

  @Patch(":productId/variants/:variantId")
  @UseGuards(AbilityGuard)
  @CheckAbility("update", "inventory:products")
  updateVariant(
    @Param("productId", ParseIntPipe) _productId: number,
    @Param("variantId", ParseIntPipe) variantId: number,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.updateVariant(u.orgId, variantId, body);
  }
}
