import {
  BadRequestException,
  Body,
  Controller,
  Post,
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
import { KbMediaService, type KbMediaUploadResult } from "./kb-media.service";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbMediaController {
  constructor(private readonly media: KbMediaService) {}

  @Post("media")
  @RequirePermission("kb:pages:update")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_FILE_SIZE } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Body("pageId") rawPageId?: string,
  ): Promise<KbMediaUploadResult> {
    if (!file) throw new BadRequestException("No file provided");
    const parsed = rawPageId ? Number(rawPageId) : undefined;
    const pageId = parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    return this.media.upload(file, u, pageId);
  }
}
