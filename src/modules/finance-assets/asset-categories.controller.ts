import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AssetCategoriesService } from "./asset-categories.service";
import {
  createCategorySchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type ListCategoriesQuery,
  type UpdateCategoryInput,
} from "./dto/assets.schemas";

@RequireModule("accounting")
@Controller("accounting/assets/categories")
@UseGuards(JwtAuthGuard)
export class AssetCategoriesController {
  constructor(private readonly categories: AssetCategoriesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  list(
    @Query(new ZodValidationPipe(listCategoriesQuerySchema)) query: ListCategoriesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.create(u.orgId, body);
  }

  @Patch(":categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  update(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.update(u.orgId, categoryId, body);
  }
}
