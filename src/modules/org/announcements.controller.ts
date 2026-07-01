import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AnnouncementsService } from "./announcements.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/announcements")
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
  create(@CurrentUser() u: CurrentUserContext, @Body() body: Omit<typeof import("../../db/schema").announcements.$inferInsert, "id" | "orgId" | "authorId" | "readCount" | "createdAt" | "updatedAt">) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":announcementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("announcementId", ParseIntPipe) id: number,
    @Body() body: Partial<typeof import("../../db/schema").announcements.$inferInsert>,
  ) {
    return this.service.update(u.orgId, id, body);
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
