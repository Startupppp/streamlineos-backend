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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import {
  addReactionSchema,
  commentSchema,
  updateCommentSchema,
  type AddReactionInput,
  type CommentInput,
  type UpdateCommentInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { commentRowSchema, commentEditResultSchema, reactionSchema } from "./dto/build-tickets-response.schemas";

const ticketInProjectParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdcommentIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive(), commentId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdcommentIdParams_ = z.object({ projectId: z.string().min(1), ticketId: z.string().min(1), commentId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdcommentIdemojiParams = z.object({ projectId: z.string().min(1), ticketId: z.string().min(1), commentId: z.coerce.number().int().positive(), emoji: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketCommentsController {
  constructor(private readonly subresources: ProjectsTicketSubresourcesService) {}

  @Post(":projectId/tickets/:ticketId/comments")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(commentRowSchema)
  @Validate({ params: ticketInProjectParams, body: commentSchema })
  addComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: CommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addComment(u, projectId, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(commentRowSchema)
  @Validate({ params: projectIdticketIdcommentIdParams })
  getComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getComment(u, projectId, ticketId, commentId);
  }

  @Patch(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(commentEditResultSchema)
  @Validate({ params: projectIdticketIdcommentIdParams, body: updateCommentSchema })
  editComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body() body: UpdateCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.editComment(u, projectId, ticketId, commentId, body.content);
  }

  @Delete(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdcommentIdParams })
  deleteComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteComment(u, projectId, ticketId, commentId);
  }

  @Post(":projectId/tickets/:ticketId/comments/:commentId/reactions")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(reactionSchema)
  @Validate({ params: projectIdticketIdcommentIdParams_, body: addReactionSchema })
  addReaction(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body() body: AddReactionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addReaction(commentId, u.userId, u.orgId, body.emoji, actingMembershipId(u.principal), ticketId);
  }

  @Delete(":projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdcommentIdemojiParams })
  removeReaction(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @Param("emoji") emoji: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeReaction(commentId, u.userId, u.orgId, decodeURIComponent(emoji), actingMembershipId(u.principal), ticketId);
  }
}
