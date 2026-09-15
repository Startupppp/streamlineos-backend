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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import {
  addLabelSchema,
  addRelatedLinkSchema,
  addRelationSchema,
  addWatcherSchema,
  attachmentSchema,
  removeRelationQuerySchema,
  updateRelatedLinkSchema,
  type AddLabelInput,
  type AddRelatedLinkInput,
  type AddRelationInput,
  type AddWatcherInput,
  type AttachmentInput,
  type RemoveRelationQuery,
  type UpdateRelatedLinkInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  ticketListRowSchema,
  watcherSchema,
  ticketRelationSchema,
  gitLinkSchema,
  relatedLinkSchema,
  attachmentCreateResultSchema,
} from "./dto/build-tickets-response.schemas";

const projectIdticketIdParams = z.object({ projectId: z.string().min(1), ticketId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdParams_ = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdlabelIdParams = z.object({ projectId: z.string().min(1), ticketId: z.coerce.number().int().positive(), labelId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdlinkIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive(), linkId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketAssociationsController {
  constructor(private readonly subresources: ProjectsTicketSubresourcesService) {}

  @Get(":projectId/tickets/:ticketId/subtasks")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(ticketListRowSchema))
  @Validate({ params: projectIdticketIdParams })
  getSubtasks(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getSubtasks(u.orgId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/relations")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(ticketRelationSchema))
  @Validate({ params: projectIdticketIdParams_ })
  listRelations(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.listRelations(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/relations")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(ticketRelationSchema)
  @Validate({ params: projectIdticketIdParams_, body: addRelationSchema })
  addRelation(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddRelationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addRelation(u, projectId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/relations")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdParams_, query: removeRelationQuerySchema })
  removeRelation(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query() query: RemoveRelationQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeRelation(u, projectId, ticketId, query.relatedId);
  }

  @Get(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(watcherSchema))
  @Validate({ params: projectIdticketIdParams })
  getWatchers(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getWatchers(u.orgId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(watcherSchema)
  @Validate({ params: projectIdticketIdParams, body: addWatcherSchema })
  addWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddWatcherInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addWatcher(u, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdParams })
  removeWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeWatcher(u, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/labels")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(successSchema)
  @Validate({ params: projectIdticketIdParams, body: addLabelSchema })
  addLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addLabel(u.orgId, u.userId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/labels/:labelId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdlabelIdParams })
  removeLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeLabel(u.orgId, u.userId, ticketId, labelId);
  }

  @Post(":projectId/tickets/:ticketId/attachments")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(attachmentCreateResultSchema)
  @Validate({ params: projectIdticketIdParams, body: attachmentSchema })
  addAttachment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addAttachment(u, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/git-links")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(gitLinkSchema))
  @Validate({ params: projectIdticketIdParams_ })
  getGitLinks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getGitLinks(u.orgId, projectId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/related-links")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(relatedLinkSchema))
  @Validate({ params: projectIdticketIdParams_ })
  listRelatedLinks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.listRelatedLinks(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/related-links")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(relatedLinkSchema)
  @Validate({ params: projectIdticketIdParams_, body: addRelatedLinkSchema })
  addRelatedLink(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddRelatedLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addRelatedLink(u, projectId, ticketId, body);
  }

  @Patch(":projectId/tickets/:ticketId/related-links/:linkId")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(relatedLinkSchema)
  @Validate({ params: projectIdticketIdlinkIdParams, body: updateRelatedLinkSchema })
  updateRelatedLink(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("linkId", ParseIntPipe) linkId: number,
    @Body() body: UpdateRelatedLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateRelatedLink(u, projectId, ticketId, linkId, body);
  }

  @Delete(":projectId/tickets/:ticketId/related-links/:linkId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdlinkIdParams })
  deleteRelatedLink(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteRelatedLink(u, projectId, ticketId, linkId);
  }
}
