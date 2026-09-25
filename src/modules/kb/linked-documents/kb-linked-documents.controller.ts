import { Controller, Get, Header, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { AccessService } from "../../access/access.service";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
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

/**
 * HR documents in the knowledge base, for readers. No module-gate decorator: KB is a universal module and no KB
 * controller carries one (pinned by kb-module-gate.spec). Every route answers 404 while `hrms.kb.link` is off.
 * Who may see an entry is decided in SQL by the query service, never here.
 */
@Controller("kb/linked-documents")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbLinkedDocumentsController {
  constructor(
    private readonly flags: KbHrLinkFlagsService,
    private readonly query: KbLinkedDocumentQueryService,
    private readonly files: KbLinkedDocumentFileService,
    private readonly access: AccessService,
  ) {}

  // Searching needs the search switch, which itself needs linking; every other read needs only linking.
  private async caller(currentUser: CurrentUserContext, needs: "link" | "search" = "link"): Promise<LinkedDocumentCaller> {
    await this.flags.assertEnabled(currentUser.orgId, needs);
    return {
      orgId: currentUser.orgId,
      userId: currentUser.userId,
      canPublish: await this.access.holds(currentUser, "hr:documents:publish"),
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

  // A signed URL is a bearer credential: it is never cached, never logged, and lives 300 seconds.
  @ResponseSchema(openLinkedDocumentResponseSchema)
  @Post(":linkedDocumentId/open")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @BodylessAction()
  @RequirePermission("kb:pages:view")
  @Validate({ params: linkedDocumentParamsSchema })
  async open(@Param("linkedDocumentId", ParseIntPipe) linkedDocumentId: number, @CurrentUser() currentUser: CurrentUserContext) {
    return this.files.open(await this.caller(currentUser), linkedDocumentId);
  }
}
