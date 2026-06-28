import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbCategoriesService } from "./kb-categories.service";
import {
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "./dto/kb.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbCategoriesController {
  constructor(private readonly categories: KbCategoriesService) {}

  @Get("spaces/:spaceId/categories")
  @RequirePermission("kb:spaces:view")
  list(@Param("spaceId", ParseIntPipe) spaceId: number, @CurrentUser() u: CurrentUserContext) {
    return this.categories.listBySpace(u, spaceId);
  }

  @Post("spaces/:spaceId/categories")
  @RequirePermission("kb:categories:manage")
  create(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.create(u, spaceId, body);
  }

  @Patch("categories/:categoryId")
  @RequirePermission("kb:categories:manage")
  update(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.categories.update(u, categoryId, body);
  }

  @Delete("categories/:categoryId")
  @RequirePermission("kb:categories:manage")
  remove(@Param("categoryId", ParseIntPipe) categoryId: number, @CurrentUser() u: CurrentUserContext) {
    return this.categories.remove(u.orgId, categoryId);
  }
}
