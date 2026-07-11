import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrCasesService } from "./hr-cases.service";
import {
  createCaseSchema,
  anonymousReportSchema,
  updateCaseSchema,
  listCasesSchema,
  createNoteSchema,
  addDocumentSchema,
  type CreateCaseInput,
  type AnonymousReportInput,
  type UpdateCaseInput,
  type ListCasesInput,
  type CreateNoteInput,
  type AddDocumentInput,
} from "./dto/hr-cases.schemas";
import { AccessService } from "../access/access.service";

@RequireModule("hr")
@Controller("hr/cases")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrCasesController {
  constructor(
    private readonly cases: HrCasesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("hr:cases:view")
  async list(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listCasesSchema)) query: ListCasesInput,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.list(user.orgId, user.userId, hasConfidential, query);
  }

  @Get("stats")
  @RequirePermission("hr:cases:view")
  async stats(@CurrentUser() user: CurrentUserContext) {
    return this.cases.countByStatus(user.orgId);
  }

  @Get(":id")
  @RequirePermission("hr:cases:view")
  async getById(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.getById(user.orgId, id, user.userId, hasConfidential);
  }

  @Post()
  @RequirePermission("hr:cases:manage")
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createCaseSchema)) body: CreateCaseInput,
    @Req() req: Request,
  ) {
    return this.cases.create(user.orgId, user.userId, body, req.ip);
  }

  @Post("anonymous")
  @RequirePermission("hr:cases:view")
  async createAnonymous(
    @Body(new ZodValidationPipe(anonymousReportSchema)) body: AnonymousReportInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.cases.createAnonymous(user.orgId, body);
  }

  @Patch(":id")
  @RequirePermission("hr:cases:manage")
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateCaseSchema)) body: UpdateCaseInput,
    @Req() req: Request,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.update(user.orgId, id, user.userId, hasConfidential, body, req.ip);
  }

  @Delete(":id")
  @RequirePermission("hr:cases:manage")
  @HttpCode(204)
  async delete(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    const hasConfidential = await this.canConfidential(user);
    await this.cases.softDelete(user.orgId, id, user.userId, hasConfidential);
  }

  @Post(":id/investigate")
  @RequirePermission("hr:cases:manage")
  async startInvestigation(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.startInvestigation(user.orgId, id, user.userId, hasConfidential, req.ip);
  }

  @Get(":id/notes")
  @RequirePermission("hr:cases:view")
  async listNotes(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.listNotes(user.orgId, id, user.userId, hasConfidential);
  }

  @Post(":id/notes")
  @RequirePermission("hr:cases:manage")
  async addNote(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(createNoteSchema)) body: CreateNoteInput,
    @Req() req: Request,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.addNote(user.orgId, id, user.userId, hasConfidential, body, req.ip);
  }

  @Get(":id/documents")
  @RequirePermission("hr:cases:view")
  async listDocuments(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.listDocuments(user.orgId, id, user.userId, hasConfidential);
  }

  @Post(":id/documents")
  @RequirePermission("hr:cases:manage")
  async addDocument(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(addDocumentSchema)) body: AddDocumentInput,
    @Req() req: Request,
  ) {
    const hasConfidential = await this.canConfidential(user);
    return this.cases.addDocument(user.orgId, id, user.userId, hasConfidential, body, req.ip);
  }

  private async canConfidential(user: CurrentUserContext): Promise<boolean> {
    if (user.isOrgOwner || user.isPlatformAdmin) return true;
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    return perms.has("hr:cases:confidential");
  }
}
