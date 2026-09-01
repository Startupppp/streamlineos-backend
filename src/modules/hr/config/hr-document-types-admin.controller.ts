import {
  Body,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrDocumentTypesService } from "./hr-document-types.service";
import {
  createDocumentTypeSchema,
  updateDocumentTypeSchema,
  type CreateDocumentTypeInput,
  type UpdateDocumentTypeInput,
} from "./dto/document-types.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const documentTypeIdParams = z.object({ documentTypeId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/document-types")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrDocumentTypesAdminController {
  constructor(private readonly documentTypes: HrDocumentTypesService) {}

  @Post()
  @RequirePermission("hr:documents:manage")
  @HttpCode(201)
  @Validate({ body: createDocumentTypeSchema })
  create(
    @Body() body: CreateDocumentTypeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.documentTypes.create(u.orgId, body);
  }

  @Patch(":documentTypeId")
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentTypeIdParams, body: updateDocumentTypeSchema })
  async update(
    @Param("documentTypeId", ParseIntPipe) documentTypeId: number,
    @Body() body: UpdateDocumentTypeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.documentTypes.getById(u.orgId, documentTypeId);
    if (!existing) throw new NotFoundException("Document type not found.");
    return this.documentTypes.update(u.orgId, documentTypeId, body);
  }

  @Delete(":documentTypeId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  @Validate({ params: documentTypeIdParams })
  async remove(
    @Param("documentTypeId", ParseIntPipe) documentTypeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.documentTypes.getById(u.orgId, documentTypeId);
    if (!existing) throw new NotFoundException("Document type not found.");
    return this.documentTypes.softDelete(u.orgId, documentTypeId);
  }
}
