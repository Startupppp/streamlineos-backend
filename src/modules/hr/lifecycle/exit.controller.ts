import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
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
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ExitService } from "./exit.service";
import { ExitWriteService } from "./exit-write.service";
import { ExperienceLetterService } from "./experience-letter.service";
import {
  experienceLetterSchema,
  resignationCreateSchema,
  resignationUpdateSchema,
  resignationFinalReviewSchema,
  resignationHrReviewSchema,
  listResignationsQuerySchema,
  type ExperienceLetterInput,
  type ResignationCreateInput,
  type ResignationUpdateInput,
  type ResignationFinalReviewInput,
  type ResignationHrReviewInput,
  type ListResignationsQueryInput,
} from "./dto/hr-lifecycle.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { StorageService } from "../../storage/storage.service";
import { AuditService } from "../../../common/audit/audit.service";
import { resolveExitAdmin } from "./exit-scope";

@RequireModule("hr")
@Controller("hr/exit")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExitController {
  constructor(
    private readonly exit: ExitService,
    private readonly exitWrite: ExitWriteService,
    private readonly experienceLetters: ExperienceLetterService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private async isExitAdmin(currentUser: CurrentUserContext): Promise<boolean> {
    return resolveExitAdmin(this.access, currentUser);
  }

  @Get()
  @RequirePermission("hr:exit:view")
  async list(
    @Query(new ZodValidationPipe(listResignationsQuerySchema)) query: ListResignationsQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.list(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:exit:create")
  create(
    @Body(new ZodValidationPipe(resignationCreateSchema)) body: ResignationCreateInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    if (currentUser.isOrgOwner) {
      throw new ForbiddenException(
        "The organization owner cannot submit a resignation through this system.",
      );
    }
    return this.exitWrite.create(currentUser.orgId, currentUser.userId, body);
  }

  @Patch(":resignationId/hr-review")
  @RequirePermission("hr:exit:manage")
  hrReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationHrReviewSchema)) body: ResignationHrReviewInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exitWrite.hrReview(currentUser.orgId, currentUser.userId, resignationId, body);
  }

  @Patch(":resignationId/final-review")
  @RequirePermission("hr:exit:approve")
  finalReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationFinalReviewSchema)) body: ResignationFinalReviewInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exitWrite.finalReview(currentUser.orgId, currentUser.userId, resignationId, body);
  }

  @Patch(":resignationId")
  @RequirePermission("hr:exit:view")
  async update(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body(new ZodValidationPipe(resignationUpdateSchema)) body: ResignationUpdateInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exitWrite.update(
      currentUser.orgId,
      { userId: currentUser.userId, role: currentUser.role, isApprover: await this.isExitAdmin(currentUser) },
      resignationId,
      body,
    );
  }

  @Get("analytics")
  @RequirePermission("hr:exit:manage")
  getAnalytics(@CurrentUser() currentUser: CurrentUserContext) {
    return this.exit.getAnalytics(currentUser.orgId);
  }

  @Post("experience-letter")
  @HttpCode(201)
  @RequirePermission("hr:exit:manage")
  createExperienceLetter(
    @Body(new ZodValidationPipe(experienceLetterSchema)) body: ExperienceLetterInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.experienceLetters.create(currentUser.orgId, currentUser.userId, body);
  }

  @Get(":resignationId/letter")
  @RequirePermission("hr:exit:view")
  async getLetter(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.getLetter(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), resignationId);
  }

  @Get(":resignationId/file")
  @RequirePermission("hr:exit:view")
  async getUploadedLetter(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ): Promise<{ url: string; expiresIn: number }> {
    const record = await this.exit.getFileReference(
      currentUser.orgId,
      currentUser.userId,
      await this.isExitAdmin(currentUser),
      resignationId,
    );
    const fileKey = this.storage.getFileKeyFromUrl(record.fileUrl);
    if (!this.storage.isValidFileKey(fileKey)) {
      throw new NotFoundException("Resignation letter is unavailable.");
    }

    const expiresIn = 300;
    const url = await this.storage.getFileUrl(currentUser.orgId, fileKey, expiresIn);
    await this.audit.logCritical({
      action: "hr.resignation_letter_viewed",
      userId: currentUser.userId,
      orgId: currentUser.orgId,
      targetId: String(record.id),
      targetType: "resignation",
    });
    return { url, expiresIn };
  }

  @Get(":resignationId/progress")
  @RequirePermission("hr:exit:view")
  async getProgress(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.getProgress(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), resignationId);
  }

  @Patch(":resignationId/withdraw")
  @RequirePermission("hr:exit:view")
  async withdraw(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.withdraw(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), resignationId);
  }

  @Get(":resignationId")
  @RequirePermission("hr:exit:view")
  async getDetail(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.getDetail(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), resignationId);
  }
}
