import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AnnouncementsService } from "./announcements.service";
import {
  createHrAnnouncementSchema,
  updateHrAnnouncementSchema,
  type CreateHrAnnouncementInput,
  type UpdateHrAnnouncementInput,
} from "./dto/announcements.schemas";

@UseGuards(JwtAuthGuard)
@Controller("org/announcements")
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Get("all")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  listAll(@CurrentUser() u: CurrentUserContext) {
    return this.service.listAll(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createHrAnnouncementSchema)) body: CreateHrAnnouncementInput,
  ) {
    const { targetIds = [], publishAt, expiresAt, ...rest } = body;
    return this.service.create(u.orgId, u.userId, targetIds, {
      ...rest,
      publishAt: publishAt ? new Date(publishAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
  }

  @Patch(":announcementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("announcementId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateHrAnnouncementSchema)) body: UpdateHrAnnouncementInput,
  ) {
    const { targetIds, publishAt, expiresAt, ...rest } = body;
    return this.service.update(u.orgId, id, targetIds, {
      ...rest,
      ...(publishAt !== undefined
        ? { publishAt: publishAt ? new Date(publishAt) : null }
        : {}),
      ...(expiresAt !== undefined
        ? { expiresAt: expiresAt ? new Date(expiresAt) : null }
        : {}),
    });
  }

  @Delete(":announcementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  remove(@CurrentUser() u: CurrentUserContext, @Param("announcementId", ParseIntPipe) id: number) {
    return this.service.remove(u.orgId, id);
  }

  @Post(":announcementId/read")
  markRead(@CurrentUser() u: CurrentUserContext, @Param("announcementId", ParseIntPipe) id: number) {
    return this.service.markRead(id, u.userId);
  }
}
