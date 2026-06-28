import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
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
import { KbTranslationsService } from "./kb-translations.service";
import {
  upsertTranslationSchema,
  type UpsertTranslationInput,
} from "./dto/kb-translations.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbTranslationsController {
  constructor(private readonly translations: KbTranslationsService) {}

  @Get("articles/:articleId/translations")
  @RequirePermission("kb:articles:view")
  async list(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.list(u.orgId, articleId);
  }

  @Get("articles/:articleId/translations/:locale")
  @RequirePermission("kb:articles:view")
  async get(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("locale") locale: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.get(u.orgId, articleId, locale);
  }

  @Put("articles/:articleId/translations/:locale")
  @RequirePermission("kb:articles:update")
  async upsert(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("locale") locale: string,
    @Body(new ZodValidationPipe(upsertTranslationSchema)) body: UpsertTranslationInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.upsert(u.orgId, articleId, locale, body);
  }

  @Delete("articles/:articleId/translations/:locale")
  @HttpCode(200)
  @RequirePermission("kb:articles:update")
  async remove(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("locale") locale: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.remove(u.orgId, articleId, locale);
  }
}
