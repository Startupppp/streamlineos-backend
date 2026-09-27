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
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
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
} from "../dto/projects.schemas";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../../common/openapi/response-envelopes";
import {
  ticketListRowSchema,
  ticketWatcherSchema,
  watcherMutationSchema,
  ticketRelationSchema,
  ticketRelationListItemSchema,
  gitLinkSchema,
  relatedLinkSchema,
  attachmentCreateResultSchema,
} from "../dto/build-tickets-response.schemas";
import { projectAndTicketIdParams } from "../dto/build-params.schemas";

const ticketInProjectParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdlabelIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive(), labelId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdlinkIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive(), linkId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketAssociationsController {
  constructor(private readonly subresources: ProjectsTicketSubresourcesService) {}

  @Get(":projectId/tickets/:ticketId/subtasks")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(ticketListRowSchema))
  @Validate({ params: ticketInProjectParams })
  getSubtasks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getSubtasks(u, projectId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/relations")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(ticketRelationListItemSchema))
  @Validate({ params: projectAndTicketIdParams })
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
  @Validate({ params: projectAndTicketIdParams, body: addRelationSchema })
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
  @Validate({ params: projectAndTicketIdParams, query: removeRelationQuerySchema })
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
  @ResponseSchema(z.array(ticketWatcherSchema))
  @Validate({ params: ticketInProjectParams })
  getWatchers(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getWatchers(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(watcherMutationSchema)
  @Validate({ params: ticketInProjectParams, body: addWatcherSchema })
  addWatcher(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddWatcherInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addWatcher(u, projectId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: ticketInProjectParams })
  removeWatcher(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeWatcher(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/labels")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(successSchema)
  @Validate({ params: ticketInProjectParams, body: addLabelSchema })
  addLabel(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AddLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addLabel(u, projectId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/labels/:labelId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdlabelIdParams })
  removeLabel(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeLabel(u, projectId, ticketId, labelId);
  }

  @Post(":projectId/tickets/:ticketId/attachments")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(attachmentCreateResultSchema)
  @Validate({ params: ticketInProjectParams, body: attachmentSchema })
  addAttachment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addAttachment(u, projectId, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/git-links")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(gitLinkSchema))
  @Validate({ params: projectAndTicketIdParams })
  getGitLinks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getGitLinks(u, projectId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/related-links")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(relatedLinkSchema))
  @Validate({ params: projectAndTicketIdParams })
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
  @Validate({ params: projectAndTicketIdParams, body: addRelatedLinkSchema })
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
