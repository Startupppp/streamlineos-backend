import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead } from "../../access/scoped-read";
import { selfOnboardingRead } from "./onboarding-scope";
import { AuditService } from "../../../common/audit/audit.service";
import { StorageService } from "../../storage/storage.service";
import { parseStorageKey } from "../../storage/storage-key";
import { OnboardingViewsService } from "./onboarding-views.service";
import {
  createOwnOnboardingDocSchema,
  listOnboardingDocsQuerySchema,
  type CreateOwnOnboardingDocInput,
  type ListOnboardingDocsQueryInput,
} from "./dto/hr-lifecycle.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  onboardingDocumentListSchema,
  onboardingDocumentRowSchema,
  signedDocFileSchema,
} from "./dto/lifecycle-response.schemas";

const docIdParams = z.object({ docId: z.coerce.number().int().positive() }).strict();

@Controller("hr/onboarding-docs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OnboardingViewsController {
  constructor(
    private readonly onboardingViews: OnboardingViewsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  @Get("me")
  @ResponseSchema(onboardingDocumentListSchema)
  @RequirePermission("self:onboarding-docs")
  @Validate({ query: listOnboardingDocsQuerySchema })
  listMine(
    @Query() query: ListOnboardingDocsQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboardingViews.list(selfOnboardingRead(currentUser), false, query);
  }

  @Post("me")
  @ResponseSchema(onboardingDocumentRowSchema)
  @HttpCode(201)
  @RequirePermission("self:onboarding-docs")
  @Validate({ body: createOwnOnboardingDocSchema })
  createMine(
    @Body()
    body: CreateOwnOnboardingDocInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.onboardingViews.create(selfOnboardingRead(currentUser), false, body);
  }

  @Get("me/:docId/file")
  @ResponseSchema(signedDocFileSchema)
  @RequirePermission("self:onboarding-docs")
  @Validate({ params: docIdParams })
  getMyFile(
    @Param("docId", ParseIntPipe) docId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.signFile(currentUser, docId, selfOnboardingRead(currentUser));
  }

  private async signFile(
    currentUser: CurrentUserContext,
    docId: number,
    read: ScopedRead,
  ): Promise<{ url: string; fileName: string; expiresIn: number }> {
    const document = await this.onboardingViews.getFileReference(read, docId);
    const fileKey = this.storage.getFileKeyFromUrl(document.fileUrl);
    if (!this.storage.isValidFileKey(fileKey)) {
      throw new NotFoundException("Document file is unavailable.");
    }
    const { folderRoot } = parseStorageKey(fileKey, currentUser.orgId);
    if (folderRoot !== "onboarding" && folderRoot !== "onboarding-docs") {
      throw new NotFoundException("Document file is unavailable.");
    }

    const expiresIn = 300;
    const url = await this.storage.getFileUrl(currentUser.orgId, fileKey, expiresIn, undefined, {
      preauthorized: true,
    });
    await this.audit.logCritical({
      action: "hr.onboarding_document_viewed",
      userId: currentUser.userId,
      orgId: currentUser.orgId,
      targetId: String(document.id),
      targetType: "onboarding_document",
      metadata: { fileName: document.fileName },
    });
    return { url, fileName: document.fileName, expiresIn };
  }
}
