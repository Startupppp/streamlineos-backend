import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ApDocumentsService } from "./ap-documents.service";
import {
  createApDocumentSchema,
  listApDocumentsQuerySchema,
  updateApDocumentSchema,
  type CreateApDocumentInput,
  type ListApDocumentsQuery,
  type UpdateApDocumentInput,
} from "./dto/ap-documents.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  apTaxPreviewResponseSchema,
  createApDocumentResponseSchema,
  getApDocumentResponseSchema,
  listApDocumentsResponseSchema,
  postApDocumentResponseSchema,
  removeApDocumentResponseSchema,
  updateApDocumentResponseSchema,
} from "./dto/ap-response.schemas";

/**
 * Bills and debit notes. One resource, because they are one table — the
 * `documentType` on the payload says which, and a debit note posts the mirror
 * of a bill rather than travelling a separate code path.
 */
@RequireModule("accounting")
@Controller("accounting/payables/documents")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ApDocumentsController {
  constructor(private readonly documents: ApDocumentsService) {}

  @Get()
  @ResponseSchema(listApDocumentsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:read")
  list(
    @Query(new ZodValidationPipe(listApDocumentsQuerySchema)) query: ListApDocumentsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.documents.list(user.orgId, query);
  }

  @Get(":apDocumentId")
  @ResponseSchema(getApDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:read")
  get(@Param("apDocumentId") apDocumentId: string, @CurrentUser() user: CurrentUserContext) {
    return this.documents.get(user.orgId, apDocumentId);
  }

  /** What the tax engine would say, with nothing written. */
  @Get(":apDocumentId/tax-preview")
  @ResponseSchema(apTaxPreviewResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:read")
  previewTax(
    @Param("apDocumentId") apDocumentId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.documents.previewTax(user.orgId, apDocumentId);
  }

  @Post()
  @ResponseSchema(createApDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createApDocumentSchema)) body: CreateApDocumentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.documents.create(user.orgId, user.userId, body);
  }

  @Patch(":apDocumentId")
  @ResponseSchema(updateApDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  update(
    @Param("apDocumentId") apDocumentId: string,
    @Body(new ZodValidationPipe(updateApDocumentSchema)) body: UpdateApDocumentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.documents.update(user.orgId, apDocumentId, body);
  }

  @Delete(":apDocumentId")
  @ResponseSchema(removeApDocumentResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  remove(@Param("apDocumentId") apDocumentId: string, @CurrentUser() user: CurrentUserContext) {
    return this.documents.remove(user.orgId, apDocumentId);
  }

  @Post(":apDocumentId/post")
  @ResponseSchema(postApDocumentResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:manage")
  @HttpCode(200)
  @Idempotent("accounting.payables.document.post")
  post(@Param("apDocumentId") apDocumentId: string, @CurrentUser() user: CurrentUserContext) {
    return this.documents.post(user.orgId, user.userId, apDocumentId);
  }
}
