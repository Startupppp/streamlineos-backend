import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AssetCategoriesService } from "./asset-categories.service";
import {
  createCategorySchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type ListCategoriesQuery,
  type UpdateCategoryInput,
} from "./dto/assets.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  assetCategoryListResponseSchema,
  assetCategorySchema,
} from "./dto/assets-response.schemas";

const categoryIdParams = z.object({ categoryId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/assets/categories")
@UseGuards(JwtAuthGuard)
export class AssetCategoriesController {
  constructor(private readonly categories: AssetCategoriesService) {}

  @Get()
  @ResponseSchema(assetCategoryListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  @Validate({ query: listCategoriesQuerySchema })
  list(
    @Query() query: ListCategoriesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(assetCategorySchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @HttpCode(201)
  @Validate({ body: createCategorySchema })
  create(
    @Body() body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.create(u.orgId, body);
  }

  @Patch(":categoryId")
  @ResponseSchema(assetCategorySchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @Validate({ params: categoryIdParams, body: updateCategorySchema })
  update(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body() body: UpdateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.update(u.orgId, categoryId, body);
  }
}
