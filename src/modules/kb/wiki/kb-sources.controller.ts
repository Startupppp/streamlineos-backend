import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbSourcesService, type KbSourceListItem } from "./kb-sources.service";
import {
  createKbSourceNoteSchema,
  kbArticleIdParamsSchema,
  kbPageIdParamsSchema,
  kbArticleIngestionStatusSchema,
  kbPageIngestionStatusSchema,
  kbSourceIdParamsSchema,
  kbSourcesListQuerySchema,
  type CreateKbSourceNoteInput,
  type KbArticleIngestionStatus,
  type KbPageIngestionStatus,
  type KbSourcesListQuery,
} from "./dto/kb-sources.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  MultipartAction,
  ResponseSchema,
} from "../../../common/openapi/zod-operation-contracts";
import {
  kbSourceListItemSchema,
  kbSourcePageSchema,
  kbSourceSchema,
  kbSourceSuccessSchema,
} from "./dto/kb-space-response.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSourcesController {
  constructor(private readonly sources: KbSourcesService) {}

  @Get("sources")
  @RequirePermission("kb:pages:view")
  @Validate({ query: kbSourcesListQuerySchema })
  @ResponseSchema(kbSourcePageSchema)
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: KbSourcesListQuery,
  ) {
    return this.sources.list(u.orgId, query);
  }

  @Get("sources/:sourceId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: kbSourceIdParamsSchema })
  @ResponseSchema(kbSourceListItemSchema)
  async get(
    @Param("sourceId", ParseIntPipe) sourceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<KbSourceListItem> {
    return this.sources.get(u.orgId, sourceId);
  }

  @Get("articles/:articleId/indexing-status")
  @RequirePermission("kb:articles:view")
  @Validate({ params: kbArticleIdParamsSchema })
  @ResponseSchema(kbArticleIngestionStatusSchema)
  async articleIngestionStatus(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<KbArticleIngestionStatus> {
    return this.sources.articleIngestionStatus(u, articleId);
  }

  @Get("pages/:pageId/indexing-status")
  @RequirePermission("kb:pages:view")
  @Validate({ params: kbPageIdParamsSchema })
  @ResponseSchema(kbPageIngestionStatusSchema)
  async pageIngestionStatus(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<KbPageIngestionStatus> {
    return this.sources.pageIngestionStatus(u, pageId);
  }

  @Post("sources")
  @MultipartAction({ file: "file", fields: { spaceId: "string" } })
  @Idempotent("kb.source.create")
  @RequirePermission("kb:pages:create")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  @HttpCode(201)
  @ResponseSchema(kbSourceSchema)
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Body("spaceId") rawSpaceId?: string,
  ) {
    if (!file) throw new BadRequestException("No file provided");
    const parsed = rawSpaceId ? Number(rawSpaceId) : undefined;
    const spaceId =
      parsed !== undefined && Number.isInteger(parsed) && parsed > 0
        ? parsed
        : undefined;
    return this.sources.createFile(u, file, spaceId);
  }

  @Post("sources/note")
  @Idempotent("kb.source.note")
  @RequirePermission("kb:pages:create")
  @HttpCode(201)
  @Validate({ body: createKbSourceNoteSchema })
  @ResponseSchema(kbSourceSchema)
  async createNote(
    @Body() body: CreateKbSourceNoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sources.createNote(u, body);
  }

  @Delete("sources/:sourceId")
  @RequirePermission("kb:pages:delete")
  @Validate({ params: kbSourceIdParamsSchema })
  @ResponseSchema(kbSourceSuccessSchema)
  async remove(
    @Param("sourceId", ParseIntPipe) sourceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sources.remove(u.orgId, sourceId);
  }
}
