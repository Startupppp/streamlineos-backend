import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrDocumentTypesService } from "./hr-document-types.service";
import {
  createDocumentTypeSchema,
  listDocumentTypesSchema,
  updateDocumentTypeSchema,
  type CreateDocumentTypeInput,
  type ListDocumentTypesInput,
  type UpdateDocumentTypeInput,
} from "./dto/document-types.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/document-types")
@UseGuards(JwtAuthGuard)
export class HrDocumentTypesController {
  constructor(
    private readonly documentTypes: HrDocumentTypesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listDocumentTypesSchema)) query: ListDocumentTypesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isAdmin = u.isOrgOwner || perms.has("hr:documents:manage");
    if (!isAdmin && !perms.has("hr:documents:view") && !perms.has("self:onboarding-docs")) {
      throw new ForbiddenException("Permission denied");
    }
    return this.documentTypes.list(u.orgId, isAdmin, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:documents:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createDocumentTypeSchema)) body: CreateDocumentTypeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documentTypes.create(u.orgId, body);
  }

  @Get(":documentTypeId")
  async getOne(
    @Param("documentTypeId", ParseIntPipe) documentTypeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isAdmin = u.isOrgOwner || perms.has("hr:documents:manage");
    if (!isAdmin && !perms.has("hr:documents:view") && !perms.has("self:onboarding-docs")) {
      throw new ForbiddenException("Permission denied");
    }
    const row = await this.documentTypes.getById(u.orgId, documentTypeId);
    if (!row) throw new NotFoundException("Document type not found.");
    return row;
  }

  @Patch(":documentTypeId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:documents:manage")
  async update(
    @Param("documentTypeId", ParseIntPipe) documentTypeId: number,
    @Body(new ZodValidationPipe(updateDocumentTypeSchema)) body: UpdateDocumentTypeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.documentTypes.getById(u.orgId, documentTypeId);
    if (!existing) throw new NotFoundException("Document type not found.");
    return this.documentTypes.update(u.orgId, documentTypeId, body);
  }

  @Delete(":documentTypeId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:documents:manage")
  async remove(
    @Param("documentTypeId", ParseIntPipe) documentTypeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.documentTypes.getById(u.orgId, documentTypeId);
    if (!existing) throw new NotFoundException("Document type not found.");
    return this.documentTypes.softDelete(u.orgId, documentTypeId);
  }
}
