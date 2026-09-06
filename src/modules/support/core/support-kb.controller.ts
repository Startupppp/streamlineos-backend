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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { SupportKbService } from "./support-kb.service";
import {
  createKbArticleSchema,
  createKbCategorySchema,
  listKbArticlesSchema,
  updateKbArticleSchema,
  updateKbCategorySchema,
  type CreateKbArticleInput,
  type CreateKbCategoryInput,
  type ListKbArticlesInput,
  type UpdateKbArticleInput,
  type UpdateKbCategoryInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("support")
@Controller("support/kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportKbController {
  constructor(private readonly kb: SupportKbService) {}

  @Get("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  listCategories(@CurrentUser() u: CurrentUserContext) {
    return this.kb.listCategories(u.orgId);
  }

  @Post("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ body: createKbCategorySchema })
  createCategory(
    @Body() body: CreateKbCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createCategory(u.orgId, body);
  }

  @Patch("categories/:categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @Validate({ body: updateKbCategorySchema })
  updateCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body() body: UpdateKbCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.updateCategory(u.orgId, categoryId, body);
  }

  @Delete("categories/:categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  deleteCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteCategory(u.orgId, categoryId);
  }

  @Get("articles")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @Validate({ query: listKbArticlesSchema })
  listArticles(
    @Query() query: ListKbArticlesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listArticles(u.orgId, query);
  }

  @Post("articles")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ body: createKbArticleSchema })
  createArticle(
    @Body() body: CreateKbArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createArticle(u.orgId, u.userId, body);
  }

  @Get("articles/:articleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  getArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.getArticle(u.orgId, articleId);
  }

  @Patch("articles/:articleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @Validate({ body: updateKbArticleSchema })
  updateArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: UpdateKbArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.updateArticle(u.orgId, articleId, body);
  }

  @Delete("articles/:articleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  deleteArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteArticle(u.orgId, articleId);
  }

}
