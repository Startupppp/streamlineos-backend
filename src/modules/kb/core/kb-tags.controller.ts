import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbTagsService } from "./kb-tags.service";
import {
  createTagSchema,
  setArticleTagsSchema,
  type CreateTagInput,
  type SetArticleTagsInput,
} from "./dto/kb-tags.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbTagListSchema,
  kbTagSchema,
  kbTagSuccessSchema,
} from "./dto/kb-core-response.schemas";
import { z } from "zod";

const tagIdParams = z.object({ tagId: z.coerce.number().int().positive() }).strict();
const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbTagsController {
  constructor(private readonly tags: KbTagsService) {}

  @Get("tags")
  @RequirePermission("kb:spaces:view")
  @ResponseSchema(kbTagListSchema)
  async list(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return await this.tags.list(u.orgId);
  }

  @Post("tags")
  @RequirePermission("kb:articles:manage")
  @HttpCode(201)
  @Validate({ body: createTagSchema })
  @ResponseSchema(kbTagSchema)
  async create(
    @Body() body: CreateTagInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.tags.create(u.orgId, body);
  }

  @Delete("tags/:tagId")
  @RequirePermission("kb:articles:manage")
  @Validate({ params: tagIdParams })
  @ResponseSchema(kbTagSuccessSchema)
  async remove(
    @Param("tagId", ParseIntPipe) tagId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.tags.remove(u.orgId, tagId);
  }

  @Get("articles/:articleId/tags")
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  @ResponseSchema(kbTagListSchema)
  async getArticleTags(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.tags.getArticleTags(u.orgId, articleId);
  }

  @Put("articles/:articleId/tags")
  @RequirePermission("kb:articles:update")
  @Validate({ params: articleIdParams, body: setArticleTagsSchema })
  @ResponseSchema(kbTagListSchema)
  async setArticleTags(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: SetArticleTagsInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.tags.setArticleTags(u.orgId, articleId, body);
  }
}
