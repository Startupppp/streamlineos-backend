import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
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
  updateDocumentTypeSchema,
  type CreateDocumentTypeInput,
  type UpdateDocumentTypeInput,
} from "./dto/document-types.schemas";

@Controller("hr/document-types")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrDocumentTypesController {
  constructor(
    private readonly documentTypes: HrDocumentTypesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("hr:documents:view")
  async list(@CurrentUser() u: CurrentUserContext) {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || perms.has("hr:documents:manage");
    return this.documentTypes.list(u.orgId, isAdmin);
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
