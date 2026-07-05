import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentCandidatesService } from "./recruitment-candidates.service";
import { RecruitmentCandidateOpsService } from "./recruitment-candidate-ops.service";
import { AccessService } from "../access/access.service";
import {
  bgvStatusSchema,
  bulkImportSchema,
  bulkRejectSchema,
  bulkShortlistSchema,
  candidateListSchema,
  createApplicationSchema,
  createCandidateSchema,
  importSchema,
  linkDuplicateSchema,
  slaResetSchema,
  stageSchema,
  updateCandidateSchema,
  type BgvStatusInput,
  type BulkImportInput,
  type BulkRejectInput,
  type BulkShortlistInput,
  type CandidateListInput,
  type CreateApplicationInput,
  type CreateCandidateInput,
  type ImportInput,
  type LinkDuplicateInput,
  type SlaResetInput,
  type StageInput,
  type UpdateCandidateInput,
} from "./dto/candidates.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/recruitment/candidates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentCandidatesController {
  constructor(
    private readonly candidates: RecruitmentCandidatesService,
    private readonly ops: RecruitmentCandidateOpsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(candidateListSchema)) query: CandidateListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createCandidateSchema)) body: CreateCandidateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.create(u.orgId, body);
  }

  @Post("bulk-import")
  @HttpCode(201)
  async bulkImport(
    @Body(new ZodValidationPipe(bulkImportSchema)) body: BulkImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.ops.bulkImport(u.orgId, body);
  }

  @Post("import")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  importCandidates(
    @Body(new ZodValidationPipe(importSchema)) body: ImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.importCandidates(u.orgId, body);
  }

  @Post("bulk-reject")
  async bulkReject(
    @Body(new ZodValidationPipe(bulkRejectSchema)) body: BulkRejectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden: HR/Admin role required");
    }
    return this.ops.bulkReject(u.orgId, u.userId, body);
  }

  @Post("bulk-shortlist")
  async bulkShortlist(
    @Body(new ZodValidationPipe(bulkShortlistSchema)) body: BulkShortlistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden: HR/Admin role required");
    }
    return this.ops.bulkShortlist(u.orgId, u.userId, body);
  }

  @Get("duplicates")
  findDuplicates(@CurrentUser() u: CurrentUserContext) {
    return this.candidates.findDuplicates(u.orgId);
  }

  @Get(":candidateId")
  getOne(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.getDetail(u.orgId, candidateId);
  }

  @Patch(":candidateId")
  @RequirePermission("hr:employees:manage")
  update(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(updateCandidateSchema)) body: UpdateCandidateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.update(u.orgId, candidateId, body);
  }

  @Delete(":candidateId")
  @RequirePermission("hr:employees:manage")
  remove(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.remove(u.orgId, candidateId);
  }

  @Patch(":candidateId/stage")
  @RequirePermission("hr:employees:manage")
  moveStage(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(stageSchema)) body: StageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.moveStage(u.orgId, u.userId, candidateId, body);
  }

  @Get(":candidateId/sla")
  getSla(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.getSla(u.orgId, candidateId);
  }

  @Patch(":candidateId/sla")
  @RequirePermission("hr:employees:manage")
  resetSla(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(slaResetSchema)) body: SlaResetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.resetSla(u.orgId, candidateId, body);
  }

  @Post(":candidateId/applications")
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  createApplication(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(createApplicationSchema)) body: CreateApplicationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.createApplication(u.orgId, candidateId, body);
  }

  @Post(":candidateId/link-duplicate")
  @RequirePermission("hr:employees:manage")
  linkDuplicate(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(linkDuplicateSchema)) body: LinkDuplicateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.linkDuplicate(u.orgId, candidateId, body.duplicateOfId);
  }

  @Post(":candidateId/unlink-duplicate")
  @RequirePermission("hr:employees:manage")
  unlinkDuplicate(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.unlinkDuplicate(u.orgId, candidateId);
  }

  @Patch(":candidateId/bgv-status")
  async updateBgvStatus(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(bgvStatusSchema)) body: BgvStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden: HR role required");
    }
    return this.ops.updateBgvStatus(u.orgId, candidateId, body);
  }
}
