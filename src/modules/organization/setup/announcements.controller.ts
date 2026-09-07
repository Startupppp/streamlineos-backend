import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AnnouncementsService } from "./announcements.service";
import {
  createHrAnnouncementSchema,
  updateHrAnnouncementSchema,
  type CreateHrAnnouncementInput,
  type UpdateHrAnnouncementInput,
} from "./dto/announcements.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import { z } from "zod";
import {
  announcementListResponseSchema,
  announcementResponseSchema,
} from "./dto/announcement-response.schema";

const announcementIdParams = z.object({ announcementId: z.coerce.number().int().positive() }).strict();

@UseGuards(JwtAuthGuard)
@Controller("org/announcements")
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}

  @Get()
  @Universal()
  @ResponseSchema(announcementListResponseSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Get("all")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  @ResponseSchema(announcementListResponseSchema)
  listAll(@CurrentUser() u: CurrentUserContext) {
    return this.service.listAll(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  @Validate({ body: createHrAnnouncementSchema })
  @ResponseSchema(announcementResponseSchema)
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateHrAnnouncementInput,
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
  @Validate({ params: announcementIdParams, body: updateHrAnnouncementSchema })
  @ResponseSchema(announcementResponseSchema)
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("announcementId", ParseIntPipe) id: number,
    @Body() body: UpdateHrAnnouncementInput,
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
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:announcements:manage")
  @Validate({ params: announcementIdParams })
  async remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("announcementId", ParseIntPipe) id: number,
  ) {
    await this.service.remove(u.orgId, id);
    return { success: true as const };
  }

  @Post(":announcementId/read")
  @BodylessAction()
  @ResponseSchema(successSchema)
  @Universal()
  @Validate({ params: announcementIdParams })
  async markRead(
    @CurrentUser() u: CurrentUserContext,
    @Param("announcementId", ParseIntPipe) id: number,
  ) {
    await this.service.markRead(u.orgId, id, u.userId);
    return { success: true as const };
  }
}
