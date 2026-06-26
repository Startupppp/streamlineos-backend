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
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentCandidateRecordsService } from "./recruitment-candidate-records.service";
import { RECRUITMENT_ADMIN_ROLES } from "./recruitment-roles";
import {
  addVaultDocumentSchema,
  createCalibrationSchema,
  createReferenceCheckSchema,
  createReferralSchema,
  generateDocumentSchema,
  updateCalibrationSchema,
  updateReferenceCheckSchema,
  updateReferralSchema,
  type AddVaultDocumentInput,
  type CreateCalibrationInput,
  type CreateReferenceCheckInput,
  type CreateReferralInput,
  type GenerateDocumentInput,
  type UpdateCalibrationInput,
  type UpdateReferenceCheckInput,
  type UpdateReferralInput,
} from "./dto/candidate-records.schemas";

@Controller("hr/recruitment/candidates/:candidateId")
@UseGuards(JwtAuthGuard)
export class RecruitmentCandidateRecordsController {
  constructor(private readonly records: RecruitmentCandidateRecordsService) {}

  @Get("calibration")
  listCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listCalibration(u.orgId, candidateId);
  }

  @Post("calibration")
  @HttpCode(201)
  createCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(createCalibrationSchema)) body: CreateCalibrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.records.createCalibration(u.orgId, u.userId, candidateId, body);
  }

  @Patch("calibration")
  updateCalibration(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(updateCalibrationSchema)) body: UpdateCalibrationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.records.updateCalibration(u.orgId, candidateId, body);
  }

  @Get("referral")
  listReferrals(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listReferrals(u.orgId, candidateId);
  }

  @Post("referral")
  @HttpCode(201)
  createReferral(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(createReferralSchema)) body: CreateReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.createReferral(u.orgId, candidateId, body);
  }

  @Patch("referral")
  updateReferral(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(updateReferralSchema)) body: UpdateReferralInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.updateReferral(u.orgId, candidateId, body);
  }

  @Get("reference-checks")
  listReferenceChecks(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listReferenceChecks(u.orgId, candidateId);
  }

  @Post("reference-checks")
  @HttpCode(201)
  createReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(createReferenceCheckSchema)) body: CreateReferenceCheckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.createReferenceCheck(u.orgId, u.userId, candidateId, body);
  }

  @Patch("reference-checks/:checkId")
  updateReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("checkId", ParseIntPipe) checkId: number,
    @Body(new ZodValidationPipe(updateReferenceCheckSchema)) body: UpdateReferenceCheckInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.updateReferenceCheck(u.orgId, candidateId, checkId, body);
  }

  @Delete("reference-checks/:checkId")
  deleteReferenceCheck(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("checkId", ParseIntPipe) checkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.deleteReferenceCheck(u.orgId, candidateId, checkId);
  }

  @Get("documents")
  listDocuments(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.listDocuments(u.orgId, candidateId);
  }

  @Post("documents")
  @HttpCode(201)
  generateDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(generateDocumentSchema)) body: GenerateDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.records.generateDocument(u.orgId, u.userId, candidateId, body);
  }

  @Get("documents/:documentId/view")
  async viewDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Param("documentId", ParseIntPipe) documentId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const doc = await this.records.viewDocument(u.orgId, candidateId, documentId);
    const safeTitle = doc.title.replace(/[^a-z0-9_-]/gi, "_");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${safeTitle}.html"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(doc.htmlContent);
  }

  @Get("vault")
  listVault(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.records.listVault(u.orgId, candidateId);
  }

  @Post("vault")
  @HttpCode(201)
  addVaultDocument(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body(new ZodValidationPipe(addVaultDocumentSchema)) body: AddVaultDocumentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Forbidden");
    return this.records.addVaultDocument(u.orgId, u.userId, candidateId, body);
  }

  @Get("vault/access-logs")
  listVaultAccessLogs(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) throw new ForbiddenException("Access denied — HR only");
    return this.records.listVaultAccessLogs(u.orgId, candidateId);
  }
}
