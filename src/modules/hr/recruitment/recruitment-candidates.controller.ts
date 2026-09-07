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
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  candidateListResponseSchema,
  candidateSchema,
  bulkImportResultSchema,
  candidateImportResponseSchema,
  candidateBulkRejectResponseSchema,
  candidateBulkShortlistResponseSchema,
  candidateDuplicateGroupSchema,
  candidateDetailSchema,
  candidateMoveStageResponseSchema,
  candidateSlaTrackingSchema,
  jobApplicationSchema,
  successSchema,
} from "./dto/recruitment-response.schemas";

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
  @ResponseSchema(candidateListResponseSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: candidateListSchema })
  list(
    @Query() query: CandidateListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(candidateSchema)
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
  @ResponseSchema(bulkImportResultSchema)
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
  @ResponseSchema(candidateImportResponseSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: importSchema })
  importCandidates(
    @Body() body: ImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.importCandidates(u.orgId, body);
  }

  @Post("bulk-reject")
  @ResponseSchema(candidateBulkRejectResponseSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: bulkRejectSchema })
  bulkReject(
    @Body() body: BulkRejectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.bulkReject(u.orgId, u.userId, body);
  }

  @Post("bulk-shortlist")
  @ResponseSchema(candidateBulkShortlistResponseSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: bulkShortlistSchema })
  bulkShortlist(
    @Body() body: BulkShortlistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.bulkShortlist(u.orgId, u.userId, body);
  }

  @Get("duplicates")
  @ResponseSchema(z.array(candidateDuplicateGroupSchema))
  @RequirePermission("hr:employees:view")
  findDuplicates(@CurrentUser() u: CurrentUserContext) {
    return this.candidates.findDuplicates(u.orgId);
  }

  @Get(":candidateId")
  @ResponseSchema(candidateDetailSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  getOne(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.getDetail(u.orgId, candidateId);
  }

  @Patch(":candidateId")
  @ResponseSchema(candidateSchema)
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
  @NoContentResponse()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  async remove(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.candidates.remove(u.orgId, candidateId);
  }

  @Patch(":candidateId/stage")
  @ResponseSchema(candidateMoveStageResponseSchema)
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
  @ResponseSchema(z.array(candidateSlaTrackingSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  getSla(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.getSla(u.orgId, candidateId);
  }

  @Patch(":candidateId/sla")
  @ResponseSchema(candidateSlaTrackingSchema)
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
  @ResponseSchema(jobApplicationSchema)
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
  @ResponseSchema(successSchema)
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
  @ResponseSchema(successSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  unlinkDuplicate(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.candidates.unlinkDuplicate(u.orgId, candidateId);
  }

  @Patch(":candidateId/bgv-status")
  @ResponseSchema(successSchema)
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
