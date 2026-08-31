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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmProductsService } from "./crm-products.service";
import {
  createProductSchema,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from "./dto/products.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const productIdParams = z.object({ productId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ body: createProductSchema })
  create(
    @Body() body: CreateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.products.create(u.orgId, body);
  }

  @Patch("products/:productId")
  @RequirePermission("crm:products:manage")
  @Validate({ params: productIdParams, body: updateProductSchema })
  async update(
    @Param("productId", ParseIntPipe) productId: number,
    @Body() body: UpdateProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const product = await this.products.update(u.orgId, productId, body);
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }

  @Delete("products/:productId")
  @HttpCode(200)
  @RequirePermission("crm:products:manage")
  @Validate({ params: productIdParams })
  async remove(
    @Param("productId", ParseIntPipe) productId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: true }> {
    await this.products.remove(u.orgId, productId);
    return { success: true };
  }
}
