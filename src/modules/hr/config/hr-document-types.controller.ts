import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrDocumentTypesService } from "./hr-document-types.service";
import {
  listDocumentTypesSchema,
  type ListDocumentTypesInput,
} from "./dto/document-types.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { documentTypeListPageSchema, documentTypeRowSchema } from "./dto/config-response.schemas";
import { z } from "zod";

const documentTypeIdParams = z.object({ documentTypeId: z.coerce.number().int().positive() }).strict();

@Controller("hr/document-types")
@UseGuards(JwtAuthGuard)
export class HrDocumentTypesController {
  constructor(
    private readonly documentTypes: HrDocumentTypesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @ResponseSchema(documentTypeListPageSchema)
  @AuthorizedInService("a three-key check in the handler: hr:documents:view scope=all, hr:documents:view or self:onboarding-docs")
  @Validate({ query: listDocumentTypesSchema })
  async list(
    @Query() query: ListDocumentTypesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const docViewScope = u.isOrgOwner ? ("all" as const) : perms.get("hr:documents:view");
    const isAdmin = docViewScope === "all";
    if (!docViewScope && !perms.has("self:onboarding-docs")) {
      throw new ForbiddenException("Permission denied");
    }
    return this.documentTypes.list(u.orgId, isAdmin, query);
  }

  @Get(":documentTypeId")
  @ResponseSchema(documentTypeRowSchema)
  @AuthorizedInService("a three-key check in the handler: hr:documents:view scope=all, hr:documents:view or self:onboarding-docs")
  @Validate({ params: documentTypeIdParams })
  async getOne(
    @Param("documentTypeId", ParseIntPipe) documentTypeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const docViewScope = u.isOrgOwner ? ("all" as const) : perms.get("hr:documents:view");
    if (!docViewScope && !perms.has("self:onboarding-docs")) {
      throw new ForbiddenException("Permission denied");
    }
    const row = await this.documentTypes.getById(u.orgId, documentTypeId);
    if (!row) throw new NotFoundException("Document type not found.");
    return row;
  }
}
