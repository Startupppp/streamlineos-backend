import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { DocumentAccessService } from "./document-access.service";
import { DocumentVersionsService } from "./document-versions.service";
import type { ClassificationActor } from "./document-classification.service";
import {
  documentVersionParams,
  documentVersionsParams,
  uploadDocumentVersionSchema,
  type UploadDocumentVersionInput,
} from "./dto/document-versions.schemas";
import { documentVersionsResponseSchema } from "./dto/document-versions-response.schemas";

/**
 * The file history of an HR document. Reading and uploading need organisation-wide document access (a person who
 * can see only their own documents has no say in the company's); approving a version is publish authority, because
 * approval is what changes the file everyone reads.
 */
@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DocumentVersionsController {
  constructor(
    private readonly versions: DocumentVersionsService,
    private readonly documentAccess: DocumentAccessService,
  ) {}

  private actor(currentUser: CurrentUserContext): ClassificationActor {
    return { userId: currentUser.userId, orgId: currentUser.orgId, membershipId: actingMembershipId(currentUser.principal) };
  }

  @ResponseSchema(documentVersionsResponseSchema)
  @Get("documents/:documentId/versions")
  @RequirePermission("hr:documents:view")
  @Validate({ params: documentVersionsParams })
  async list(@Param("documentId", ParseIntPipe) documentId: number, @CurrentUser() currentUser: CurrentUserContext) {
    await this.documentAccess.assertCanAct(await this.documentAccess.principalFor(currentUser), documentId, "view");
    return this.versions.list(currentUser.orgId, documentId);
  }

  @ResponseSchema(documentVersionsResponseSchema)
  @Post("documents/:documentId/versions")
  @HttpCode(201)
  @Idempotent("hr.document.version-upload")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentVersionsParams, body: uploadDocumentVersionSchema })
  async upload(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: UploadDocumentVersionInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    await this.documentAccess.assertCanAct(await this.documentAccess.principalFor(currentUser), documentId, "manage");
    return this.versions.upload(this.actor(currentUser), documentId, body);
  }

  @ResponseSchema(documentVersionsResponseSchema)
  @Post("documents/:documentId/versions/:versionNumber/approve")
  @HttpCode(200)
  @BodylessAction()
  @Idempotent("hr.document.version-approve")
  @RequirePermission("hr:documents:publish")
  @Validate({ params: documentVersionParams })
  async approve(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.versions.approve(this.actor(currentUser), documentId, versionNumber);
  }
}
