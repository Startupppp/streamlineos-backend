import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
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
import { CrmProductsService } from "./crm-products.service";
import {
  createProductSchema,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from "./dto/products.schemas";

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmProductsController {
  constructor(private readonly products: CrmProductsService) {}

  @Get("products")
  @RequirePermission("crm:products:manage")
  list(
    @Query("search") search: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.list(u.orgId, search);
  }

  @Post("products")
  @RequirePermission("crm:products:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.create(u.orgId, body);
  }

  @Patch("products/:productId")
  @RequirePermission("crm:products:manage")
  async update(
    @Param("productId", ParseIntPipe) productId: number,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const product = await this.products.update(u.orgId, productId, body);
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }

  @Delete("products/:productId")
  @HttpCode(204)
  @RequirePermission("crm:products:manage")
  async remove(
    @Param("productId", ParseIntPipe) productId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.products.remove(u.orgId, productId);
  }
}
