import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CommentDraftsService } from "./comment-drafts.service";
import { CommentDraftGeneratorService } from "./comment-draft-generator.service";
import {
  recordDraftFailureSchema,
  upsertCommentDraftSchema,
  type RecordDraftFailureInput,
  type UpsertCommentDraftInput,
} from "./dto/comment-drafts.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { actingMembershipId } from "../../../common/auth/principal";
import { NoTenantTransaction } from "../../../common/tenant";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  commentDraftSchema,
  commentDraftWithTicketSchema,
  deletedSchema,
  draftFailureSchema,
  generatedCommentDraftSchema,
} from "./dto/comment-drafts-response.schemas";

const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();
const draftIdParams = z.object({ draftId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/comment-drafts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CommentDraftsController {
  constructor(
    private readonly svc: CommentDraftsService,
    private readonly generator: CommentDraftGeneratorService,
  ) {}

  @Get("mine")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(commentDraftWithTicketSchema))
  listMine(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listMine(u);
  }

  @Put("tickets/:ticketId")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(commentDraftSchema)
  @Validate({ params: ticketIdParams, body: upsertCommentDraftSchema })
  upsert(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: UpsertCommentDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsert(u, ticketId, body);
  }

  @Post("tickets/:ticketId/generate-draft")
  @HttpCode(200)
  @RequirePermission("build:ai:use")
  @ResponseSchema(generatedCommentDraftSchema)
  @Validate({ params: ticketIdParams })
  @NoTenantTransaction()
  @BodylessAction()
  generateDraft(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.generator.generate(u, ticketId);
  }

  @Post(":draftId/failures")
  @HttpCode(200)
  @RequirePermission("build:tickets:view")
  @ResponseSchema(draftFailureSchema)
  @Validate({ params: draftIdParams, body: recordDraftFailureSchema })
  recordFailure(
    @Param("draftId", ParseIntPipe) draftId: number,
    @Body() body: RecordDraftFailureInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.recordDraftFailure(
      u.orgId,
      actingMembershipId(u.principal),
      draftId,
      body.error,
    );
  }

  @Delete("mine")
  @HttpCode(200)
  @RequirePermission("build:tickets:view")
  @ResponseSchema(deletedSchema)
  deleteAll(@CurrentUser() u: CurrentUserContext) {
    return this.svc.deleteAllMine(u.orgId, actingMembershipId(u.principal), u.userId);
  }

  @Delete("tickets/:ticketId")
  @HttpCode(200)
  @RequirePermission("build:tickets:view")
  @ResponseSchema(deletedSchema)
  @Validate({ params: ticketIdParams })
  deleteByTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteByTicket(u.orgId, actingMembershipId(u.principal), u.userId, ticketId);
  }

  @Delete(":draftId")
  @HttpCode(200)
  @RequirePermission("build:tickets:view")
  @ResponseSchema(deletedSchema)
  @Validate({ params: draftIdParams })
  deleteOne(
    @Param("draftId", ParseIntPipe) draftId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteOne(u.orgId, actingMembershipId(u.principal), u.userId, draftId);
  }
}
