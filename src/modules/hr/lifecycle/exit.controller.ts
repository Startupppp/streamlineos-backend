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
import { actingMembershipId } from "../../../common/auth/principal";

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
import { parseStorageKey } from "../../storage/storage-key";
import { AuditService } from "../../../common/audit/audit.service";
import { resolveExitAdmin } from "./exit-scope";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  resignationListSchema,
  resignationSchema,
  exitAnalyticsSchema,
  experienceLetterCreateResponseSchema,
  exitLetterSchema,
  uploadedFileUrlSchema,
  resignationProgressSchema,
  successSchema,
} from "./dto/lifecycle-response.schemas";

const resignationIdParams = z.object({ resignationId: z.coerce.number().int().positive() }).strict();

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
  @ResponseSchema(resignationListSchema)
  @RequirePermission("hr:exit:view")
  @Validate({ query: listResignationsQuerySchema })
  async list(
    @Query() query: ListResignationsQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.list(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), query, actingMembershipId(currentUser.principal));
  }

  @Post()
  @ResponseSchema(resignationSchema)
  @HttpCode(201)
  @RequirePermission("hr:exit:create")
  @Validate({ body: resignationCreateSchema })
  create(
    @Body() body: ResignationCreateInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    if (currentUser.isOrgOwner) {
      throw new ForbiddenException(
        "The organization owner cannot submit a resignation through this system.",
      );
    }
    return this.exitWrite.create(currentUser.orgId, currentUser.userId, actingMembershipId(currentUser.principal), body);
  }

  @Patch(":resignationId/hr-review")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:exit:manage")
  @Validate({ params: resignationIdParams, body: resignationHrReviewSchema })
  hrReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body() body: ResignationHrReviewInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exitWrite.hrReview(currentUser.orgId, currentUser.userId, resignationId, body);
  }

  @Patch(":resignationId/final-review")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:exit:approve")
  @Validate({ params: resignationIdParams, body: resignationFinalReviewSchema })
  finalReview(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body() body: ResignationFinalReviewInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exitWrite.finalReview(currentUser.orgId, currentUser.userId, resignationId, body);
  }

  @Patch(":resignationId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:exit:view")
  @Validate({ params: resignationIdParams, body: resignationUpdateSchema })
  async update(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @Body() body: ResignationUpdateInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exitWrite.update(
      currentUser.orgId,
      { userId: currentUser.userId, membershipId: actingMembershipId(currentUser.principal), role: currentUser.role, isApprover: await this.isExitAdmin(currentUser) },
      resignationId,
      body,
    );
  }

  @Get("analytics")
  @ResponseSchema(exitAnalyticsSchema)
  @RequirePermission("hr:exit:manage")
  getAnalytics(@CurrentUser() currentUser: CurrentUserContext) {
    return this.exit.getAnalytics(currentUser.orgId);
  }

  @Post("experience-letter")
  @ResponseSchema(experienceLetterCreateResponseSchema)
  @HttpCode(201)
  @RequirePermission("hr:exit:manage")
  @Validate({ body: experienceLetterSchema })
  createExperienceLetter(
    @Body() body: ExperienceLetterInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.experienceLetters.create(currentUser.orgId, currentUser.userId, body);
  }

  @Get(":resignationId/letter")
  @ResponseSchema(exitLetterSchema)
  @RequirePermission("hr:exit:view")
  @Validate({ params: resignationIdParams })
  async getLetter(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.getLetter(
      currentUser.orgId,
      currentUser.userId,
      await this.isExitAdmin(currentUser),
      resignationId,
      actingMembershipId(currentUser.principal),
    );
  }

  @Get(":resignationId/file")
  @ResponseSchema(uploadedFileUrlSchema)
  @RequirePermission("hr:exit:view")
  @Validate({ params: resignationIdParams })
  async getUploadedLetter(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ): Promise<{ url: string; expiresIn: number }> {
    const record = await this.exit.getFileReference(
      currentUser.orgId,
      currentUser.userId,
      await this.isExitAdmin(currentUser),
      resignationId,
      actingMembershipId(currentUser.principal),
    );
    const fileKey = this.storage.getFileKeyFromUrl(record.fileUrl);
    if (!this.storage.isValidFileKey(fileKey)) {
      throw new NotFoundException("Resignation letter is unavailable.");
    }
    const { folderRoot } = parseStorageKey(fileKey, currentUser.orgId);
    if (folderRoot !== "resignations") {
      throw new NotFoundException("Resignation letter is unavailable.");
    }

    const expiresIn = 300;
    const url = await this.storage.getFileUrl(currentUser.orgId, fileKey, expiresIn, undefined, {
      preauthorized: true,
    });
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
  @ResponseSchema(resignationProgressSchema)
  @RequirePermission("hr:exit:view")
  @Validate({ params: resignationIdParams })
  async getProgress(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.getProgress(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), resignationId, actingMembershipId(currentUser.principal));
  }

  @Patch(":resignationId/withdraw")
  @ResponseSchema(successSchema)
  @BodylessAction()
  @RequirePermission("hr:exit:view")
  @Validate({ params: resignationIdParams })
  async withdraw(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.withdraw(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), resignationId, actingMembershipId(currentUser.principal));
  }

  @Get(":resignationId")
  @ResponseSchema(resignationSchema)
  @RequirePermission("hr:exit:view")
  @Validate({ params: resignationIdParams })
  async getDetail(
    @Param("resignationId", ParseIntPipe) resignationId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.exit.getDetail(currentUser.orgId, currentUser.userId, await this.isExitAdmin(currentUser), resignationId, actingMembershipId(currentUser.principal));
  }
}
