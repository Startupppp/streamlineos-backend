import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { KbPageRecordLinksService } from "./kb-page-record-links.service";
import {
  createRecordLinkSchema,
  recordLinkByRecordQuerySchema,
  type CreateRecordLinkDto,
  type RecordLinkByRecordQuery,
} from "./dto/kb-page-record-links.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();
const linkIdParams = z.object({ linkId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@RequireModule("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageRecordLinksController {
  constructor(private readonly service: KbPageRecordLinksService) {}

  @Get("pages/:pageId/record-links")
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  list(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.service.list(user, pageId);
  }

  @Post("pages/:pageId/record-links")
  @RequirePermission("kb:pages:update")
  @HttpCode(201)
  @Validate({ params: pageIdParams })
  add(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(createRecordLinkSchema)) dto: CreateRecordLinkDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.service.add(user, pageId, dto);
  }

  @Delete("record-links/:linkId")
  @RequirePermission("kb:pages:update")
  @Validate({ params: linkIdParams })
  remove(
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.service.remove(user, linkId);
  }

  @Get("record-links/by-record")
  @RequirePermission("kb:pages:view")
  listByRecord(
    @Query(new ZodValidationPipe(recordLinkByRecordQuerySchema)) query: RecordLinkByRecordQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.service.listByRecord(user, query);
  }
}
