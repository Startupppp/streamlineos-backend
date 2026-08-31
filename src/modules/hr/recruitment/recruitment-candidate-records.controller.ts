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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentCandidateRecordsService } from "./recruitment-candidate-records.service";
import { RecruitmentCandidateAiService } from "./recruitment-candidate-ai.service";
import {
  addVaultDocumentSchema,
  createCalibrationSchema,
  createReferenceCheckSchema,
  createReferralSchema,
  generateDocumentSchema,
  rolloutDocumentsSchema,
  updateCalibrationSchema,
  updateReferenceCheckSchema,
  updateReferralSchema,
  type AddVaultDocumentInput,
  type CreateCalibrationInput,
  type CreateReferenceCheckInput,
  type CreateReferralInput,
  type GenerateDocumentInput,
  type RolloutDocumentsInput,
  type UpdateCalibrationInput,
  type UpdateReferenceCheckInput,
  type UpdateReferralInput,
} from "./dto/candidate-records.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();
const candidateAndCheckIdParams = z.object({ candidateId: z.coerce.number().int().positive(), checkId: z.coerce.number().int().positive() }).strict();
const candidateAndDocumentIdParams = z.object({ candidateId: z.coerce.number().int().positive(), documentId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentCandidateRecordsController {
  constructor(
    private readonly records: RecruitmentCandidateRecordsService,
    private readonly ai: RecruitmentCandidateAiService,
  ) {}

  @Post("ai-score")
  @BodylessAction()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  aiScore(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.aiScore(u.orgId, candidateId, u.userId);
  }

  @Post("composite-score")
  @BodylessAction()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  compositeScore(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.compositeScore(u.orgId, candidateId, u.userId);
  }

  @Post("resume-parse")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  resumeParse(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.parseResume(u.orgId, candidateId, u.userId, file, body);
  }

  @Get("rollout-documents")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listRolloutDocuments(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listRolloutDocuments(u.orgId, candidateId);
  }

  @Post("rollout-documents")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: rolloutDocumentsSchema })
  generateRolloutDocuments(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: RolloutDocumentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.generateRolloutDocuments(
      u.orgId,
      u.userId,
      candidateId,
      body,
    );
  }

  @Get("calibration")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listCalibration(u.orgId, candidateId);
  }

  @Post("calibration")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: createCalibrationSchema })
  createCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: CreateCalibrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.createCalibration(u.orgId, u.userId, candidateId, body);
  }

  @Patch("calibration")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: updateCalibrationSchema })
  updateCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: UpdateCalibrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.updateCalibration(u.orgId, candidateId, body);
  }

  @Get("referral")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listReferrals(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listReferrals(u.orgId, candidateId);
  }

  @Post("referral")
  @Idempotent("hr.recruitment.referral.create")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: createReferralSchema })
  createReferral(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: CreateReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.createReferral(u.orgId, candidateId, body);
  }

  @Patch("referral")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: updateReferralSchema })
  updateReferral(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: UpdateReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.updateReferral(u.orgId, candidateId, body);
  }

  @Get("reference-checks")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listReferenceChecks(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listReferenceChecks(u.orgId, candidateId);
  }

  @Post("reference-checks")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: createReferenceCheckSchema })
  createReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: CreateReferenceCheckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.createReferenceCheck(
      u.orgId,
      u.userId,
      candidateId,
      body,
    );
  }

  @Patch("reference-checks/:checkId")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateAndCheckIdParams, body: updateReferenceCheckSchema })
  updateReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("checkId", ParseIntPipe) checkId: number,
    @Body()
    body: UpdateReferenceCheckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.updateReferenceCheck(
      u.orgId,
      candidateId,
      checkId,
      body,
    );
  }

  @Delete("reference-checks/:checkId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateAndCheckIdParams })
  async deleteReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("checkId", ParseIntPipe) checkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.records.deleteReferenceCheck(u.orgId, candidateId, checkId);
  }

  @Get("documents")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listDocuments(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listDocuments(u.orgId, candidateId);
  }

  @Post("documents")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: generateDocumentSchema })
  generateDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: GenerateDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.generateDocument(u.orgId, u.userId, candidateId, body);
  }

  @Get("documents/:documentId/view")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateAndDocumentIdParams })
  async viewDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const doc = await this.records.viewDocument(
      u.orgId,
      candidateId,
      documentId,
    );
    const safeTitle = doc.title.replace(/[^a-z0-9_-]/gi, "_");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeTitle}.html"`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(doc.htmlContent);
  }

  @Get("vault")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  listVault(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listVault(u.orgId, candidateId);
  }

  @Post("vault")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: addVaultDocumentSchema })
  addVaultDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: AddVaultDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.addVaultDocument(u.orgId, u.userId, candidateId, body);
  }

  @Delete("vault/:documentId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateAndDocumentIdParams })
  async deleteVaultDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.records.deleteVaultDocument(u.orgId, candidateId, documentId, u.userId);
  }

  @Get("vault/access-logs")
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  listVaultAccessLogs(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listVaultAccessLogs(u.orgId, candidateId);
  }

  @Get("activity")
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  getActivity(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.getActivity(u.orgId, candidateId);
  }
}
