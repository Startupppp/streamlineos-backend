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
import { KbSourcesService } from "./kb-sources.service";
import {
  createKbSourceNoteSchema,
  type CreateKbSourceNoteInput,
} from "./dto/kb-sources.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const sourceIdParams = z.object({ sourceId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSourcesController {
  constructor(private readonly sources: KbSourcesService) {}

  @Get("sources")
  @RequirePermission("kb:pages:view")
  async list(@CurrentUser() u: CurrentUserContext) {
    return this.sources.list(u.orgId);
  }

  @Post("sources")
  @RequirePermission("kb:pages:create")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
  @HttpCode(201)
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
  @RequirePermission("kb:pages:create")
  @HttpCode(201)
  @Validate({ body: createKbSourceNoteSchema })
  async createNote(
    @Body() body: CreateKbSourceNoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sources.createNote(u, body);
  }

  @Delete("sources/:sourceId")
  @RequirePermission("kb:pages:delete")
  @Validate({ params: sourceIdParams })
  async remove(
    @Param("sourceId", ParseIntPipe) sourceId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sources.remove(u.orgId, sourceId);
  }
}
