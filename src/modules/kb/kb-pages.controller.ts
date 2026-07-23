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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import {
  createPageSchema,
  updatePageSchema,
  movePageSchema,
  lockPageSchema,
  searchPagesSchema,
  listPagesSchema,
  setVisibilitySchema,
  verifyPageSchema,
  type CreatePageInput,
  type UpdatePageInput,
  type MovePageInput,
  type LockPageInput,
  type SearchPagesInput,
  type ListPagesInput,
  type SetVisibilityInput,
  type VerifyPageInput,
} from "./dto/kb-pages.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard)
export class KbPagesController {
  constructor(
    private readonly pages: KbPagesService,
    private readonly tree: KbPageTreeService,
    private readonly access: AccessService,
  ) {}

  @Get("pages/tree")
  async getTree(
    @Query(new ZodValidationPipe(listPagesSchema)) query: ListPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.getTree(u, query.projectId);
  }

  @Get("pages/recent")
  async getRecent(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.pages.getRecent(u);
  }

  @Get("pages/favorites")
  async getFavorites(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.pages.getFavorites(u);
  }

  @Get("pages/trash")
  async getTrash(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.tree.getTrash(u);
  }

  @Get("pages/search")
  async search(
    @Query(new ZodValidationPipe(searchPagesSchema)) query: SearchPagesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.search(u, query.q);
  }

  @Post("pages")
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createPageSchema)) body: CreatePageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.create(u, body);
  }

  @Get("pages/:pageId")
  async get(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.pages.get(u, pageId, canManage);
  }

  @Patch("pages/:pageId")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  async update(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(updatePageSchema)) body: UpdatePageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.pages.update(u, pageId, body, canManage);
  }

  @Post("pages/:pageId/move")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  async move(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(movePageSchema)) body: MovePageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.move(u, pageId, body);
  }

  @Post("pages/:pageId/duplicate")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:create")
  @HttpCode(201)
  async duplicate(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.duplicate(u, pageId);
  }

  @Delete("pages/:pageId")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:delete")
  async remove(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.softDelete(u, pageId);
  }

  @Post("pages/:pageId/restore")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  async restore(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.tree.restore(u, pageId);
  }

  @Delete("pages/trash/empty")
  @UseGuards(PermissionGuard)
  @HttpCode(200)
  @RequirePermission("kb:pages:purge")
  async emptyTrash(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.tree.emptyTrash(u);
  }

  @Delete("pages/:pageId/permanent")
  @UseGuards(PermissionGuard)
  @HttpCode(204)
  @RequirePermission("kb:pages:purge")
  async hardDelete(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.tree.hardDelete(u, pageId);
  }

  @Post("pages/:pageId/favorite")
  @HttpCode(200)
  async addFavorite(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.addFavorite(u, pageId);
  }

  @Delete("pages/:pageId/favorite")
  async removeFavorite(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.removeFavorite(u, pageId);
  }

  @Post("pages/:pageId/visit")
  @HttpCode(200)
  async recordVisit(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.recordVisit(u, pageId);
  }

  @Get("pages/:pageId/backlinks")
  async backlinks(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.getBacklinks(u, pageId);
  }

  @Get("pages/:pageId/versions")
  async listVersions(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.listVersions(u, pageId);
  }

  @Get("pages/:pageId/versions/:versionNumber")
  async getVersion(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.getVersion(u, pageId, versionNumber);
  }

  @Post("pages/:pageId/versions/:versionNumber/restore")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  async restoreVersion(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.pages.restoreVersion(u, pageId, versionNumber, canManage);
  }

  @Patch("pages/:pageId/lock")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:manage")
  async lock(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(lockPageSchema)) body: LockPageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.lock(u, pageId, body.isLocked);
  }

  @Patch("pages/:pageId/visibility")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  async setVisibility(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(setVisibilitySchema)) body: SetVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const canManage = await this.resolveCanManage(u);
    return this.pages.setVisibility(u, pageId, body.visibility, canManage);
  }

  @Post("pages/:pageId/publish")
  @UseGuards(PermissionGuard)
  @HttpCode(200)
  @RequirePermission("kb:pages:update")
  async publish(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.publish(u, pageId);
  }

  @Post("pages/:pageId/archive")
  @UseGuards(PermissionGuard)
  @HttpCode(200)
  @RequirePermission("kb:pages:update")
  async archive(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.archive(u, pageId);
  }

  @Post("pages/:pageId/unarchive")
  @UseGuards(PermissionGuard)
  @HttpCode(200)
  @RequirePermission("kb:pages:update")
  async unarchive(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.unarchive(u, pageId);
  }

  @Post("pages/:pageId/verify")
  @UseGuards(PermissionGuard)
  @HttpCode(200)
  @RequirePermission("kb:pages:manage")
  async verify(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(verifyPageSchema)) body: VerifyPageInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.verify(u, pageId, body);
  }

  @Post("pages/:pageId/mark-stale")
  @UseGuards(PermissionGuard)
  @HttpCode(200)
  @RequirePermission("kb:pages:manage")
  async markStale(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.pages.markStale(u, pageId);
  }

  private async resolveCanManage(u: CurrentUserContext): Promise<boolean> {
    if (u.isOrgOwner || u.isPlatformAdmin) return true;
    const perms = await this.access.resolveUserPermissions(u.userId, u.orgId);
    return perms.has("kb:pages:manage");
  }
}
