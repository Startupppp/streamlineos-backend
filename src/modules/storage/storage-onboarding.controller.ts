import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { and, eq } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Universal } from "../../common/auth/universal.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { MultipartAction } from "../../common/openapi/zod-operation-contracts";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { documents, onboardingSteps } from "../../db/schema";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { StorageService } from "./storage.service";
import { MediaTransformRunner } from "./media-transform.runner";
import { AvScanner } from "../../common/security/av-scan";
import { validateMagicBytes } from "./file-signatures";
import { onboardingDocTypeSchema, uploadBodySchema } from "./dto/storage.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { onboardingDocumentResponseSchema } from "./dto/storage-response.schemas";

const ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];
const MAX_SIZE = 5 * 1024 * 1024;

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingDocumentsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly avScanner: AvScanner,
    private readonly transforms: MediaTransformRunner,
  ) {}

  @Post("documents")
  @ResponseSchema(onboardingDocumentResponseSchema)
  @Universal()
  @HttpCode(201)
  @MultipartAction({ file: "file", fields: { type: "string" }, requiredFields: ["type"] })
  @Validate({ body: uploadBodySchema })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("type") typeField: unknown,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ url: string }> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException(
        "Cloud storage (R2) is not configured. Contact your administrator.",
      );
    }
    if (!file) throw new BadRequestException("No file provided");

    const typeResult = onboardingDocTypeSchema.safeParse(typeField);
    if (!typeResult.success)
      throw new BadRequestException("Invalid document type");
    const type = typeResult.data;

    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        "File type not allowed. Use PDF, JPEG, PNG, or WebP.",
      );
    }
    if (!validateMagicBytes(file.buffer, file.mimetype)) {
      throw new BadRequestException("File content does not match declared type");
    }
    if (file.size > MAX_SIZE)
      throw new BadRequestException("File size must be under 5MB");

    if (!this.transforms.hasCapacity())
      throw new ServiceUnavailableException("Upload processing is saturated — retry shortly");

    const scanResult = await this.avScanner.scan(file.buffer, file.originalname, file.mimetype);
    if (scanResult.status === "infected")
      throw new UnprocessableEntityException(`Upload rejected: malware detected (${scanResult.threat})`);
    if (scanResult.status === "error")
      throw new ServiceUnavailableException("Malware scan unavailable — upload rejected");

    const { key, plannedMimeType } = await this.storage.planUpload(
      u.orgId,
      file.buffer,
      "onboarding",
      file.originalname,
      file.mimetype,
    );

    const stepName = `Upload ${type}`;
    const orgId = u.orgId;
    const userId = u.userId;
    const originalname = file.originalname;
    const mimetype = file.mimetype;
    const buffer = file.buffer;
    const fileSize = file.size;

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.insert(documents).values({
          orgId,
          userId,
          name: originalname,
          type,
          fileUrl: key,
          fileSize,
          mimeType: plannedMimeType,
          uploadedBy: userId,
        });
        const existing = await tx.query.onboardingSteps.findFirst({
          where: and(
            eq(onboardingSteps.orgId, orgId),
            eq(onboardingSteps.userId, userId),
            eq(onboardingSteps.stepName, stepName),
          ),
          columns: { id: true },
        });
        if (existing) {
          await tx
            .update(onboardingSteps)
            .set({ status: "COMPLETED", completedAt: new Date() })
            .where(and(eq(onboardingSteps.orgId, orgId), eq(onboardingSteps.id, existing.id)));
        } else {
          await tx.insert(onboardingSteps).values({
            userId,
            orgId,
            stepName,
            status: "COMPLETED",
            completedAt: new Date(),
          });
        }
      },
      { orgId },
    );

    this.transforms.submit({
      name: "onboarding.document.compress",
      orgId,
      run: async () => {
        await this.storage.compressToKey(orgId, buffer, key, originalname, mimetype);
      },
      compensate: async () => {
        await this.storage.deleteFileIfPresent(orgId, key);
      },
    });

    return { url: key };
  }
}
