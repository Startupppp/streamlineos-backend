import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { resolveDocumentsScope } from "./performance-scope";
import { KbLinkedDocumentPublishService, type PublishActor } from "../../kb/linked-documents/kb-linked-document-publish.service";
import { KbLinkedDocumentBackfillService } from "../../kb/linked-documents/kb-linked-document-backfill.service";
import { backfillInputSchema, backfillResultSchema, type BackfillInput } from "../../kb/linked-documents/dto/kb-link-backfill.schemas";
import {
  kbLinkParamsSchema,
  publishLinkSchema,
  updateLinkSchema,
  type PublishLinkInput,
  type UpdateLinkInput,
} from "../../kb/linked-documents/dto/kb-link-publish.schemas";
import { kbLinkStateResponseSchema } from "../../kb/linked-documents/dto/kb-link-state-response.schemas";


/**
 * Putting an HR document in the knowledge base, from the document. Publishing is organisation-wide authority
 * (`hr:documents:publish`, which is not scopable); reading where a document stands needs organisation-wide
 * document access. Every route answers 404 while `hrms.kb.link` is off.
 */
@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DocumentKbLinkController {
  constructor(
    private readonly links: KbLinkedDocumentPublishService,
    private readonly backfill: KbLinkedDocumentBackfillService,
    private readonly access: AccessService,
  ) {}

  private actor(currentUser: CurrentUserContext): PublishActor {
    return { userId: currentUser.userId, orgId: currentUser.orgId, membershipId: actingMembershipId(currentUser.principal) };
  }

  // One page of proposals for the documents that already look like company documents. A dry run unless the caller says otherwise; never publishes.
  @ResponseSchema(backfillResultSchema)
  @Post("documents/kb-link/backfill")
  @HttpCode(200)
  @Idempotent("hr.document.kb-backfill")
  @RequirePermission("hr:documents:publish")
  @Validate({ body: backfillInputSchema })
  async runBackfill(@Body() body: BackfillInput, @CurrentUser() currentUser: CurrentUserContext) {
    return this.backfill.run(this.actor(currentUser), body);
  }

  @ResponseSchema(kbLinkStateResponseSchema)
  @Get("documents/:documentId/kb-link")
  @RequirePermission("hr:documents:view")
  @Validate({ params: kbLinkParamsSchema })
  async state(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    if (!scope.unrestricted) throw new ForbiddenException("Organization-wide document access is required.");
    return this.links.getState(currentUser.orgId, documentId);
  }

  @ResponseSchema(kbLinkStateResponseSchema)
  @Post("documents/:documentId/kb-link")
  @HttpCode(201)
  @Idempotent("hr.document.kb-publish")
  @RequirePermission("hr:documents:publish")
  @Validate({ params: kbLinkParamsSchema, body: publishLinkSchema })
  async publish(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: PublishLinkInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.links.publish(this.actor(currentUser), documentId, body);
  }

  @ResponseSchema(kbLinkStateResponseSchema)
  @Patch("documents/:documentId/kb-link")
  @Idempotent("hr.document.kb-link-update")
  @RequirePermission("hr:documents:publish")
  @Validate({ params: kbLinkParamsSchema, body: updateLinkSchema })
  async update(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: UpdateLinkInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.links.updateLink(this.actor(currentUser), documentId, body);
  }

  // Answers with the document's state (200), not 204: the caller redraws from it.
  @ResponseSchema(kbLinkStateResponseSchema)
  @Delete("documents/:documentId/kb-link")
  @HttpCode(200)
  @BodylessAction()
  @Idempotent("hr.document.kb-unpublish")
  @RequirePermission("hr:documents:publish")
  @Validate({ params: kbLinkParamsSchema })
  async unpublish(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() currentUser: CurrentUserContext) {
    return this.links.unpublish(this.actor(currentUser), documentId);
  }
}
