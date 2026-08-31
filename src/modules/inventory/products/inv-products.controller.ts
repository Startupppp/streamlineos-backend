import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { InvProductsService } from "./inv-products.service";
import { resolveInvProductsScope } from "../stock-engine/inventory-scope";
import {
  listProductsSchema, createProductSchema, updateProductSchema,
  createVariantSchema, updateVariantSchema, createCategorySchema, createUomSchema, listVariantsSchema,
  updateCategorySchema, updateUomSchema, resolveLineTaxSchema,
  quantityCaptureSchema, h1RegisterSchema,
  type ListProductsInput, type CreateProductInput, type UpdateProductInput, type ResolveLineTaxQuery,
  type QuantityCaptureQuery, type H1RegisterQuery,
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
    private readonly products: InvProductsService,
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
  @Validate({ body: createCategorySchema })
  createCategory(
    @Body() body: CreateCategoryInput,
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
  @Validate({ body: createUomSchema })
  createUom(
    @Body() body: CreateUomInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createUom(u.orgId, body);
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
    return this.products.updateCategory(u.orgId, categoryId, body);
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
    return this.products.updateUom(u.orgId, uomId, body);
  }

  @Get("variants")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  @Validate({ query: listVariantsSchema })
  listVariants(
    @Query() filters: ListVariantsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.listVariants(u.orgId, filters);
  }

  /**
   * E2 — the tax inputs for one document line, before the line is written.
   *
   * Sits here rather than on each document module because there is one answer:
   * the SKU's classification, the organisation's registration mode, and the
   * exact tax that follows. A purchase-order screen and a sales-order screen
   * asking the same question must not be able to get different answers, and the
   * composition rule in particular has to be enforced somewhere a form cannot
   * route around.
   *
   * A read — it computes and returns, and writes nothing.
   */
  @Get("variants/:variantId/tax-treatment")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  resolveLineTax(
    @Param("variantId", ParseIntPipe) variantId: number,
    @Query(new ZodValidationPipe(resolveLineTaxSchema)) query: ResolveLineTaxQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.resolveLineTax(u.orgId, variantId, query);
  }

  /**
   * E3 — everything the person holding the pack needs, at the moment they are
   * holding it: the LASA and high-alert warnings, what this product is
   * confusable with, and the MRP printed on each batch.
   *
   * Nothing here refuses a dispense; `safety.blocksDispense` says so in the
   * payload. The one thing the pharmacy pack blocks is a receipt missing an MRP
   * — see `receipt-requirements` below.
   *
   * ⚠ This is only a safety feature where it is called. A warning delivered on a
   * catalogue page nobody has open during a pick is decoration: the caller that
   * makes it real is whatever the picker touches at the shelf, which in this
   * codebase is `POST /inventory/barcode/scan`.
   */
  @Get("variants/:variantId/pharmacy")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  pharmacyProfile(
    @Param("variantId", ParseIntPipe) variantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.pharmacyProfile(u.orgId, variantId);
  }

  /**
   * E3 — what a receipt line for this SKU has to carry before it may be posted.
   *
   * Read by the receiving screen so the operator is told at the door rather than
   * at post, and by the same service the post transaction calls, so the two
   * cannot disagree about what is required.
   */
  @Get("variants/:variantId/receipt-requirements")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  receiptRequirements(
    @Param("variantId", ParseIntPipe) variantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.receiptRequirements(u.orgId, variantId);
  }

  /**
   * E4 — what a quantity for this SKU may look like, and what a document line
   * would record for the one supplied.
   *
   * A GET with the quantity in the query: it reads a configuration, applies a
   * stored conversion factor and writes nothing.
   */
  @Get("variants/:variantId/quantity-capture")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  quantityCapture(
    @Param("variantId", ParseIntPipe) variantId: number,
    @Query(new ZodValidationPipe(quantityCaptureSchema)) query: QuantityCaptureQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.quantityCapture(u.orgId, variantId, query);
  }

  /**
   * E3 — the Schedule H1 register export, behind its own jurisdiction flag and
   * default off. A stub: it names the products in scope and states that the
   * dispensing rows are not held here. It makes no compliance claim.
   */
  @Get("pharmacy/h1-register")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  h1Register(
    @Query(new ZodValidationPipe(h1RegisterSchema)) query: H1RegisterQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.h1Register(u.orgId, query);
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
    return this.products.archiveProduct(u.orgId, productId, u.userId);
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
    return this.products.restoreProduct(u.orgId, productId, u.userId);
  }

  @Get(":productId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:read")
  @Validate({ params: productIdParams })
  get(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    return this.products.getProduct(u.orgId, productId, u.userId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:create")
  @Validate({ body: createProductSchema })
  create(
    @Body() body: CreateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.createProduct(u.orgId, u.userId, body);
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
    return this.products.updateProduct(u.orgId, productId, body);
  }

  @Delete(":productId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:products:delete")
  @Validate({ params: productIdParams })
  async delete(@Param("productId", ParseIntPipe) productId: number, @CurrentUser() u: CurrentUserContext) {
    await this.products.deleteProduct(u.orgId, productId, u.userId);
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
    return this.products.createVariant(u.orgId, productId, body);
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
    return this.products.updateVariant(u.orgId, variantId, body);
  }
}
