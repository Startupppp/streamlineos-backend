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
import { RecruitmentCalibrationService } from "./recruitment-calibration.service";
import { RecruitmentReferralChecksService } from "./recruitment-referral-checks.service";
import { RecruitmentCandidateDocsService } from "./recruitment-candidate-docs.service";
import { RecruitmentCandidateVaultService } from "./recruitment-candidate-vault.service";
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
import { resumeParseRequestSchema } from "./dto/candidate-ai.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ApiOkResponse } from "@nestjs/swagger";
import { BodylessAction, MultipartAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  aiScoreResultSchema,
  compositeScoreResultSchema,
  resumeParseResponseSchema,
  rolloutDocumentItemSchema,
  generateRolloutResponseSchema,
  calibrationSessionSchema,
  candidateReferralCandidateSchema,
  referenceCheckSchema,
  candidateDocumentSchema,
  vaultDocumentSchema,
  vaultAccessLogItemSchema,
  candidateActivityEventSchema,
} from "./dto/recruitment-response.schemas";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();
const candidateAndCheckIdParams = z.object({ candidateId: z.coerce.number().int().positive(), checkId: z.coerce.number().int().positive() }).strict();
const candidateAndDocumentIdParams = z.object({ candidateId: z.coerce.number().int().positive(), documentId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentCandidateRecordsController {
  constructor(
    private readonly calibration: RecruitmentCalibrationService,
    private readonly referralChecks: RecruitmentReferralChecksService,
    private readonly docs: RecruitmentCandidateDocsService,
    private readonly vault: RecruitmentCandidateVaultService,
    private readonly ai: RecruitmentCandidateAiService,
  ) {}

  @Post("ai-score")
  @BodylessAction()
  @ResponseSchema(aiScoreResultSchema)
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
  @ResponseSchema(compositeScoreResultSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  compositeScore(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.compositeScore(u.orgId, candidateId, u.userId);
  }

  @Post("resume-parse")
  @ResponseSchema(resumeParseResponseSchema)
  @RequirePermission("hr:employees:manage")
  @MultipartAction({ file: "file", fields: { resumeText: "string" } })
  @Validate({ params: candidateIdParams, body: resumeParseRequestSchema })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  resumeParse(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: z.infer<typeof resumeParseRequestSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.parseResume(u.orgId, candidateId, u.userId, file, body);
  }

  @Get("rollout-documents")
  @ResponseSchema(z.array(rolloutDocumentItemSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listRolloutDocuments(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.docs.listRolloutDocuments(u.orgId, candidateId);
  }

  @Post("rollout-documents")
  @HttpCode(201)
  @ResponseSchema(generateRolloutResponseSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: rolloutDocumentsSchema })
  generateRolloutDocuments(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: RolloutDocumentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.docs.generateRolloutDocuments(
      u.orgId,
      u.userId,
      candidateId,
      body,
    );
  }

  @Get("calibration")
  @ResponseSchema(z.array(calibrationSessionSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.calibration.listCalibration(u.orgId, candidateId);
  }

  @Post("calibration")
  @HttpCode(201)
  @ResponseSchema(calibrationSessionSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: createCalibrationSchema })
  createCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: CreateCalibrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.calibration.createCalibration(u.orgId, u.userId, candidateId, body);
  }

  @Patch("calibration")
  @ResponseSchema(calibrationSessionSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: updateCalibrationSchema })
  updateCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: UpdateCalibrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.calibration.updateCalibration(u.orgId, candidateId, body);
  }

  @Get("referral")
  @ResponseSchema(z.array(candidateReferralCandidateSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listReferrals(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referralChecks.listReferrals(u.orgId, candidateId);
  }

  @Post("referral")
  @Idempotent("hr.recruitment.referral.create")
  @HttpCode(201)
  @ResponseSchema(candidateReferralCandidateSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: createReferralSchema })
  createReferral(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: CreateReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referralChecks.createReferral(u.orgId, candidateId, body);
  }

  @Patch("referral")
  @ResponseSchema(candidateReferralCandidateSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: updateReferralSchema })
  updateReferral(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: UpdateReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referralChecks.updateReferral(u.orgId, candidateId, body);
  }

  @Get("reference-checks")
  @ResponseSchema(z.array(referenceCheckSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listReferenceChecks(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referralChecks.listReferenceChecks(u.orgId, candidateId);
  }

  @Post("reference-checks")
  @HttpCode(201)
  @ResponseSchema(referenceCheckSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: createReferenceCheckSchema })
  createReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: CreateReferenceCheckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referralChecks.createReferenceCheck(
      u.orgId,
      u.userId,
      candidateId,
      body,
    );
  }

  @Patch("reference-checks/:checkId")
  @ResponseSchema(referenceCheckSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateAndCheckIdParams, body: updateReferenceCheckSchema })
  updateReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("checkId", ParseIntPipe) checkId: number,
    @Body()
    body: UpdateReferenceCheckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referralChecks.updateReferenceCheck(
      u.orgId,
      candidateId,
      checkId,
      body,
    );
  }

  @Delete("reference-checks/:checkId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateAndCheckIdParams })
  async deleteReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("checkId", ParseIntPipe) checkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.referralChecks.deleteReferenceCheck(u.orgId, candidateId, checkId);
  }

  @Get("documents")
  @ResponseSchema(z.array(candidateDocumentSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  listDocuments(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.docs.listDocuments(u.orgId, candidateId);
  }

  @Post("documents")
  @HttpCode(201)
  @ResponseSchema(candidateDocumentSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: generateDocumentSchema })
  generateDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: GenerateDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.docs.generateDocument(u.orgId, u.userId, candidateId, body);
  }

  @Get("documents/:documentId/view")
  @ApiOkResponse({ schema: { type: "string" }, description: "HTML document content" })
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateAndDocumentIdParams })
  async viewDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const doc = await this.docs.viewDocument(
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
  @ResponseSchema(z.array(vaultDocumentSchema))
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  listVault(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vault.listVault(u.orgId, candidateId);
  }

  @Post("vault")
  @HttpCode(201)
  @ResponseSchema(vaultDocumentSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams, body: addVaultDocumentSchema })
  addVaultDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body()
    body: AddVaultDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vault.addVaultDocument(u.orgId, u.userId, candidateId, body);
  }

  @Delete("vault/:documentId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateAndDocumentIdParams })
  async deleteVaultDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.vault.deleteVaultDocument(u.orgId, candidateId, documentId, u.userId);
  }

  @Get("vault/access-logs")
  @ResponseSchema(z.array(vaultAccessLogItemSchema))
  @RequirePermission("hr:employees:manage")
  @Validate({ params: candidateIdParams })
  listVaultAccessLogs(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vault.listVaultAccessLogs(u.orgId, candidateId);
  }

  @Get("activity")
  @ResponseSchema(z.array(candidateActivityEventSchema))
  @RequirePermission("hr:employees:view")
  @Validate({ params: candidateIdParams })
  getActivity(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vault.getActivity(u.orgId, candidateId);
  }
}
