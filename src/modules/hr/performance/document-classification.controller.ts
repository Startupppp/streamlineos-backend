import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { resolveDocumentsManageScope, resolveDocumentsScope } from "./performance-scope";
import {
  DocumentClassificationService,
  type ClassificationActor,
} from "./document-classification.service";
import {
  classifyDocumentSchema,
  documentClassificationParams,
  setDocumentAudiencesSchema,
  type ClassifyDocumentInput,
  type SetDocumentAudiencesInput,
} from "./dto/document-classification.schemas";
import {
  classifyDocumentResponseSchema,
  documentClassificationResponseSchema,
  setDocumentAudiencesResponseSchema,
} from "./dto/document-classification-response.schemas";

const PUBLISH_PERMISSION = "hr:documents:publish";

/**
 * What a document IS (Personal, Confidential, Restricted, Internal) and who it is for. Organisation-wide
 * authority, so none of it is scoped: a caller who can see only their own documents cannot read or change
 * how the company's are classified.
 */
@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DocumentClassificationController {
  constructor(
    private readonly classification: DocumentClassificationService,
    private readonly access: AccessService,
  ) {}

  private actor(currentUser: CurrentUserContext): ClassificationActor {
    return {
      userId: currentUser.userId,
      orgId: currentUser.orgId,
      membershipId: actingMembershipId(currentUser.principal),
    };
  }

  @ResponseSchema(documentClassificationResponseSchema)
  @Get("documents/:documentId/classification")
  @RequirePermission("hr:documents:view")
  @Validate({ params: documentClassificationParams })
  async get(
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsScope(this.access, currentUser);
    if (!scope.unrestricted) throw new ForbiddenException("Organization-wide document access is required.");
    return this.classification.get(currentUser.orgId, documentId);
  }

  @ResponseSchema(classifyDocumentResponseSchema)
  @Patch("documents/:documentId/classification")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentClassificationParams, body: classifyDocumentSchema })
  async classify(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: ClassifyDocumentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveDocumentsManageScope(this.access, currentUser);
    if (!scope.unrestricted) throw new ForbiddenException("Organization-wide document access is required.");
    const canPublish = await this.access.holds(currentUser, PUBLISH_PERMISSION);
    return this.classification.classify(this.actor(currentUser), documentId, body, canPublish);
  }

  @ResponseSchema(setDocumentAudiencesResponseSchema)
  @Put("documents/:documentId/audiences")
  @RequirePermission("hr:documents:publish")
  @Validate({ params: documentClassificationParams, body: setDocumentAudiencesSchema })
  async setAudiences(
    @Param("documentId", ParseIntPipe) documentId: number,
    @Body() body: SetDocumentAudiencesInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.classification.setAudiences(this.actor(currentUser), documentId, body);
  }
}
