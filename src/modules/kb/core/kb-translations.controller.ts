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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbTranslationsService } from "./kb-translations.service";
import {
  upsertTranslationSchema,
  type UpsertTranslationInput,
} from "./dto/kb-translations.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();
const articleIdlocaleParams = z.object({ articleId: z.coerce.number().int().positive(), locale: z.string().min(1) }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbTranslationsController {
  constructor(private readonly translations: KbTranslationsService) {}

  @Get("articles/:articleId/translations")
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  async list(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.list(u.orgId, articleId);
  }

  @Get("articles/:articleId/translations/:locale")
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdlocaleParams })
  async get(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("locale") locale: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.get(u.orgId, articleId, locale);
  }

  @Put("articles/:articleId/translations/:locale")
  @RequirePermission("kb:articles:update")
  @Validate({ params: articleIdlocaleParams, body: upsertTranslationSchema })
  async upsert(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("locale") locale: string,
    @Body() body: UpsertTranslationInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.upsert(u.orgId, articleId, locale, body);
  }

  @Delete("articles/:articleId/translations/:locale")
  @HttpCode(200)
  @RequirePermission("kb:articles:update")
  @Validate({ params: articleIdlocaleParams })
  async remove(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("locale") locale: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.translations.remove(u.orgId, articleId, locale);
  }
}
