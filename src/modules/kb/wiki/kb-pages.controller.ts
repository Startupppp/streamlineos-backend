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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPageStatusService } from "./kb-page-status.service";
import { KbPageVersionsService } from "./kb-page-versions.service";
import { KbPageVisitsService } from "./kb-page-visits.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageDuplicateService } from "./kb-page-duplicate.service";
import {
  bulkPageIdsSchema,
  createPageSchema,
  updatePageSchema,
  movePageSchema,
  lockPageSchema,
  searchPagesSchema,
  listPagesSchema,
  setVisibilitySchema,
  trashPagesQuerySchema,
  verifyPageSchema,
  listVersionsQuerySchema,
  type BulkPageIdsInput,
  type CreatePageInput,
  type UpdatePageInput,
  type MovePageInput,
  type LockPageInput,
  type SearchPagesInput,
  type ListPagesInput,
  type SetVisibilityInput,
  type TrashPagesQuery,
  type VerifyPageInput,
  type ListVersionsQuery,
} from "./dto/kb-pages.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  kbBulkPageResultSchema,
  kbPageTreeSchema,
  kbPageSchema,
  kbPageListSchema,
  kbPageWithAncestorsSchema,
  kbPageSearchResponseSchema,
  kbPageSoftDeleteSchema,
  kbPageEmptyTrashSchema,
  kbPageSuccessSchema,
  kbPageBacklinkSchema,
  kbPageVersionListSchema,
  kbPageVersionSchema,
  kbTrashPageListSchema,
} from "./dto/kb-wiki-response.schemas";
import { z } from "zod";

const pageIdParams = z
  .object({ pageId: z.coerce.number().int().positive() })
  .strict();
const pageIdversionNumberParams = z
  .object({
    pageId: z.coerce.number().int().positive(),
    versionNumber: z.coerce.number().int().positive(),
  })
  .strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPagesController {
  constructor(
    private readonly pages: KbPagesService,
    private readonly status: KbPageStatusService,
    private readonly versions: KbPageVersionsService,
    private readonly visits: KbPageVisitsService,
    private readonly tree: KbPageTreeService,
    private readonly pageDuplicate: KbPageDuplicateService,
    private readonly access: AccessService,
  ) {}

  @Get("pages/tree")
  @RequirePermission("kb:pages:view")
  @Validate({ query: listPagesSchema })
  @ResponseSchema(kbPageTreeSchema)
  async getTree(
    @Query() query: ListPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.getTree(u, query.projectId);
  }

  @Get("pages/recent")
  @RequirePermission("kb:pages:view")
  @ResponseSchema(kbPageListSchema)
  async getRecent(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.visits.getRecent(u);
  }

  @Get("pages/favorites")
  @RequirePermission("kb:pages:view")
  @ResponseSchema(kbPageListSchema)
  async getFavorites(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.visits.getFavorites(u);
  }

  @Get("pages/trash")
  @RequirePermission("kb:pages:view")
  @Validate({ query: trashPagesQuerySchema })
  @ResponseSchema(kbTrashPageListSchema)
  async getTrash(
    @Query() query: TrashPagesQuery,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.getTrash(u, query);
  }

  @Post("pages/trash/restore")
  @HttpCode(200)
  @RequirePermission("kb:pages:update")
  @Validate({ body: bulkPageIdsSchema })
  @ResponseSchema(kbBulkPageResultSchema)
  async bulkRestoreFromTrash(
    @Body() body: BulkPageIdsInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.bulkRestore(u, body);
  }

  @Delete("pages/trash/purge")
  @HttpCode(200)
  @RequirePermission("kb:pages:purge")
  @Validate({ body: bulkPageIdsSchema })
  @ResponseSchema(kbBulkPageResultSchema)
  async bulkPurgeFromTrash(
    @Body() body: BulkPageIdsInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.bulkPurge(u, body);
  }

  @Get("pages/search")
  @RequirePermission("kb:pages:view")
  @Validate({ query: searchPagesSchema })
  @ResponseSchema(kbPageSearchResponseSchema)
  async search(
    @Query() query: SearchPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.search(u, query.q, query.limit);
  }

  @Post("pages")
  @HttpCode(201)
  @RequirePermission("kb:pages:create")
  @Validate({ body: createPageSchema })
  @ResponseSchema(kbPageSchema)
  async create(
    @Body() body: CreatePageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.create(u, body);
  }

  @Get("pages/:pageId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageWithAncestorsSchema)
  async get(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.pages.get(u, pageId, canManage);
  }

  @Patch("pages/:pageId")
  @RequirePermission("kb:pages:update")
  @Validate({ params: pageIdParams, body: updatePageSchema })
  @ResponseSchema(kbPageSchema)
  async update(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: UpdatePageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.pages.update(u, pageId, body, canManage);
  }

  @Post("pages/:pageId/move")
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  @Validate({ params: pageIdParams, body: movePageSchema })
  @ResponseSchema(kbPageSuccessSchema)
  async move(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: MovePageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.move(u, pageId, body);
  }

  @Post("pages/:pageId/duplicate")
  @BodylessAction()
  @RequirePermission("kb:pages:create")
  @HttpCode(201)
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSchema)
  async duplicate(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pageDuplicate.duplicate(u, pageId);
  }

  @Delete("pages/:pageId")
  @RequirePermission("kb:pages:delete")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSoftDeleteSchema)
  async remove(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.softDelete(u, pageId);
  }

  @Post("pages/:pageId/restore")
  @BodylessAction()
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSuccessSchema)
  async restore(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.restore(u, pageId);
  }

  @Delete("pages/trash/empty")
  @HttpCode(200)
  @RequirePermission("kb:pages:purge")
  @ResponseSchema(kbPageEmptyTrashSchema)
  async emptyTrash(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.tree.emptyTrash(u);
  }

  @Delete("pages/:pageId/permanent")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("kb:pages:purge")
  @Validate({ params: pageIdParams })
  async hardDelete(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.tree.hardDelete(u, pageId);
  }

  @Post("pages/:pageId/favorite")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSuccessSchema)
  async addFavorite(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.visits.addFavorite(u, pageId);
  }

  @Delete("pages/:pageId/favorite")
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSuccessSchema)
  async removeFavorite(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.visits.removeFavorite(u, pageId);
  }

  @Post("pages/:pageId/visit")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSuccessSchema)
  async recordVisit(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.visits.recordVisit(u, pageId);
  }

  @Get("pages/:pageId/backlinks")
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageBacklinkSchema)
  async backlinks(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.visits.getBacklinks(u, pageId);
  }

  @Get("pages/:pageId/versions")
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams, query: listVersionsQuerySchema })
  @ResponseSchema(kbPageVersionListSchema)
  async listVersions(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Query() query: ListVersionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.versions.listVersions(u, pageId, query.cursor, query.pageSize);
  }

  @Get("pages/:pageId/versions/:versionNumber")
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdversionNumberParams })
  @ResponseSchema(kbPageVersionSchema)
  async getVersion(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.versions.getVersion(u, pageId, versionNumber);
  }

  @Post("pages/:pageId/versions/:versionNumber/restore")
  @BodylessAction()
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  @Validate({ params: pageIdversionNumberParams })
  @ResponseSchema(kbPageSchema)
  async restoreVersion(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.versions.restoreVersion(u, pageId, versionNumber, canManage);
  }

  @Patch("pages/:pageId/lock")
  @RequirePermission("kb:pages:manage")
  @Validate({ params: pageIdParams, body: lockPageSchema })
  @ResponseSchema(kbPageSchema)
  async lock(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: LockPageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.status.lock(u, pageId, body.isLocked);
  }

  @Patch("pages/:pageId/visibility")
  @RequirePermission("kb:pages:update")
  @Validate({ params: pageIdParams, body: setVisibilitySchema })
  @ResponseSchema(kbPageSchema)
  async setVisibility(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: SetVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.pages.setVisibility(u, pageId, body.visibility, canManage);
  }

  @Post("pages/:pageId/publish")
  @BodylessAction()
  @Idempotent("kb.page.publish")
  @HttpCode(200)
  @RequirePermission("kb:pages:update")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSchema)
  async publish(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.status.publish(u, pageId);
  }

  @Post("pages/:pageId/archive")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:update")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSchema)
  async archive(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.status.archive(u, pageId);
  }

  @Post("pages/:pageId/unarchive")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:update")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSchema)
  async unarchive(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.status.unarchive(u, pageId);
  }

  @Post("pages/:pageId/verify")
  @HttpCode(200)
  @RequirePermission("kb:pages:manage")
  @Validate({ params: pageIdParams, body: verifyPageSchema })
  @ResponseSchema(kbPageSchema)
  async verify(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: VerifyPageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.status.verify(u, pageId, body);
  }

  @Post("pages/:pageId/mark-stale")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("kb:pages:manage")
  @Validate({ params: pageIdParams })
  @ResponseSchema(kbPageSchema)
  async markStale(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.status.markStale(u, pageId);
  }

  private async resolveCanManage(u: CurrentUserContext): Promise<boolean> {
    return this.access.holds(u, "kb:pages:manage");
  }
}
