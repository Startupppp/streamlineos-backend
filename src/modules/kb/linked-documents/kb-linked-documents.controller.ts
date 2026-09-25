import { Controller, Get, Header, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { DocumentAccessService } from "../../hr/performance/document-access.service";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";
import { KbLinkedDocumentFileService } from "./kb-linked-document-file.service";
import {
  linkedDocumentParamsSchema,
  listLinkedDocumentsQuerySchema,
  type ListLinkedDocumentsQuery,
} from "./dto/kb-linked-documents.schemas";
import {
  linkedDocumentDetailSchema,
  listLinkedDocumentsResponseSchema,
  openLinkedDocumentResponseSchema,
} from "./dto/kb-linked-documents-response.schemas";

@Controller("kb/linked-documents")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
export class KbLinkedDocumentsController {
  constructor(
    private readonly flags: KbHrLinkFlagsService,
    private readonly query: KbLinkedDocumentQueryService,
    private readonly files: KbLinkedDocumentFileService,
    private readonly documentAccess: DocumentAccessService,
  ) {}

  private async caller(currentUser: CurrentUserContext, needs: "link" | "search" = "link"): Promise<LinkedDocumentCaller> {
    await this.flags.assertEnabled(currentUser.orgId, needs);
    const principal = await this.documentAccess.principalFor(currentUser);
    return {
      orgId: principal.orgId,
      userId: principal.userId,
      canPublish: this.documentAccess.canPerform(principal, "publish"),
    };
  }

  @ResponseSchema(listLinkedDocumentsResponseSchema)
  @Get()
  @RequirePermission("kb:pages:view")
  @Validate({ query: listLinkedDocumentsQuerySchema })
  async list(@Query() query: ListLinkedDocumentsQuery, @CurrentUser() currentUser: CurrentUserContext) {
    return this.query.list(await this.caller(currentUser, query.q === undefined ? "link" : "search"), query);
  }

  @ResponseSchema(linkedDocumentDetailSchema)
  @Get(":linkedDocumentId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: linkedDocumentParamsSchema })
  async get(@Param("linkedDocumentId", ParseIntPipe) linkedDocumentId: number, @CurrentUser() currentUser: CurrentUserContext) {
    return this.query.get(await this.caller(currentUser), linkedDocumentId);
  }

  @ResponseSchema(openLinkedDocumentResponseSchema)
  @Post(":linkedDocumentId/open")
  @UseRateLimit("kb:linked-document-open")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @BodylessAction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: linkedDocumentParamsSchema })
  async open(@Param("linkedDocumentId", ParseIntPipe) linkedDocumentId: number, @CurrentUser() currentUser: CurrentUserContext) {
    return this.files.open(await this.caller(currentUser), linkedDocumentId);
  }
}
