import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CommentDraftsService } from "./comment-drafts.service";
import { upsertCommentDraftSchema, type UpsertCommentDraftInput } from "./dto/comment-drafts.schemas";

@RequireModule("build")
@Controller("build/comment-drafts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CommentDraftsController {
  constructor(private readonly svc: CommentDraftsService) {}

  @Get("mine")
  @RequirePermission("build:tickets:view")
  listMine(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listMine(u.orgId, u.userId);
  }

  @Put("tickets/:ticketId")
  @RequirePermission("build:tickets:view")
  upsert(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(upsertCommentDraftSchema)) body: UpsertCommentDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsert(u.orgId, u.userId, ticketId, body);
  }

  @Delete("mine")
  @HttpCode(200)
  @RequirePermission("build:tickets:view")
  deleteAll(@CurrentUser() u: CurrentUserContext) {
    return this.svc.deleteAllMine(u.orgId, u.userId);
  }

  @Delete("tickets/:ticketId")
  @HttpCode(200)
  @RequirePermission("build:tickets:view")
  deleteByTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteByTicket(u.orgId, u.userId, ticketId);
  }

  @Delete(":draftId")
  @HttpCode(200)
  @RequirePermission("build:tickets:view")
  deleteOne(
    @Param("draftId", ParseIntPipe) draftId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteOne(u.orgId, u.userId, draftId);
  }
}
