import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { and, eq } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { documents, onboardingSteps } from "../../db/schema";
import { StorageService } from "./storage.service";
import { onboardingDocTypeSchema } from "./dto/storage.schemas";

const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX_SIZE = 5 * 1024 * 1024;

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingDocumentsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  @Post("documents")
  @HttpCode(201)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
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
    if (!typeResult.success) throw new BadRequestException("Invalid document type");
    const type = typeResult.data;

    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      throw new BadRequestException("File type not allowed. Use PDF, JPEG, PNG, or WebP.");
    }
    if (file.size > MAX_SIZE) throw new BadRequestException("File size must be under 5MB");

    const result = await this.storage.uploadFile(
      file.buffer,
      "onboarding",
      file.originalname,
      file.mimetype,
    );
    const stepName = `Upload ${type}`;

    await this.db.transaction(async (tx) => {
      await tx.insert(documents).values({
        orgId: u.orgId,
        userId: u.userId,
        name: file.originalname,
        type,
        fileUrl: result.url,
        fileSize: file.size,
        mimeType: file.mimetype,
        uploadedBy: u.userId,
      });
      const existing = await tx.query.onboardingSteps.findFirst({
        where: and(eq(onboardingSteps.userId, u.userId), eq(onboardingSteps.stepName, stepName)),
      });
      if (existing) {
        await tx
          .update(onboardingSteps)
          .set({ status: "COMPLETED", completedAt: new Date() })
          .where(eq(onboardingSteps.id, existing.id));
      } else {
        await tx.insert(onboardingSteps).values({
          userId: u.userId,
          orgId: u.orgId,
          stepName,
          status: "COMPLETED",
          completedAt: new Date(),
        });
      }
    });

    return { url: result.url };
  }
}
