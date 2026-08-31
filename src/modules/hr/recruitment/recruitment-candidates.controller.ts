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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { RecruitmentCandidatesService } from "./recruitment-candidates.service";
import { RecruitmentCandidateOpsService } from "./recruitment-candidate-ops.service";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/candidates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentCandidatesController {
  constructor(
    private readonly candidates: RecruitmentCandidatesService,
    private readonly ops: RecruitmentCandidateOpsService,
  ) {}

  @Get()
  @RequirePermission("hr:employees:view")
  @Validate({ query: candidateListSchema })
  list(
    @Query() query: CandidateListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  @Validate({ body: createCandidateSchema })
  create(
    @Body() body: CreateCandidateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.create(u.orgId, body);
  }

  @Post("bulk-import")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: bulkImportSchema })
  bulkImport(
    @Body() body: BulkImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.bulkImport(u.orgId, body);
  }

  @Post("import")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: importSchema })
  importCandidates(
    @Body() body: ImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.importCandidates(u.orgId, body);
  }

  @Post("bulk-reject")
  @RequirePermission("hr:employees:manage")
  @Validate({ body: bulkRejectSchema })
  bulkReject(
    @Body() body: BulkRejectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.bulkReject(u.orgId, u.userId, body);
  }

  @Post("bulk-shortlist")
  @RequirePermission("hr:employees:manage")
  @Validate({ body: bulkShortlistSchema })
  bulkShortlist(
    @Body() body: BulkShortlistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.bulkShortlist(u.orgId, u.userId, body);
  }

  @Get("duplicates")
  @RequirePermission("hr:employees:view")
  findDuplicates(@CurrentUser() u: CurrentUserContext) {
    return this.candidates.findDuplicates(u.orgId);
  }

  @Get(":candidateId")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  getOne(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.getDetail(u.orgId, candidateId);
  }

  @Patch(":candidateId")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: updateCandidateSchema })
  update(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: UpdateCandidateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.update(u.orgId, candidateId, body);
  }

  @Delete(":candidateId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  async remove(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.candidates.remove(u.orgId, candidateId);
  }

  @Patch(":candidateId/stage")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: stageSchema })
  moveStage(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: StageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.moveStage(u.orgId, u.userId, candidateId, body);
  }

  @Get(":candidateId/sla")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  getSla(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.getSla(u.orgId, candidateId);
  }

  @Patch(":candidateId/sla")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: slaResetSchema })
  resetSla(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: SlaResetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.resetSla(u.orgId, candidateId, body);
  }

  @Post(":candidateId/applications")
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  @Validate({ params: candidateIdParams, body: createApplicationSchema })
  createApplication(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: CreateApplicationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.createApplication(u.orgId, candidateId, body);
  }

  @Post(":candidateId/link-duplicate")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: linkDuplicateSchema })
  linkDuplicate(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: LinkDuplicateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.linkDuplicate(u.orgId, candidateId, body.duplicateOfId);
  }

  @Post(":candidateId/unlink-duplicate")
  @BodylessAction()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  unlinkDuplicate(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.unlinkDuplicate(u.orgId, candidateId);
  }

  @Patch(":candidateId/bgv-status")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: bgvStatusSchema })
  updateBgvStatus(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: BgvStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.updateBgvStatus(u.orgId, candidateId, body);
  }
}
