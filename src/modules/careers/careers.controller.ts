import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Public } from "../../common/auth/public.decorator";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { CareersService, isApplyJobNotFound } from "./careers.service";
import { applySchema, type ApplyInput } from "./dto/careers.schemas";
import { type UploadResumeInput } from "./dto/resumes.schemas";
import { MultipartAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  careersJobListSchema,
  careersApplyResponseSchema,
  uploadResumeResponseSchema,
} from "./dto/careers-response.schemas";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import type { Request } from "express";

@Controller("careers")
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Public()
  @Get()
  @ResponseSchema(careersJobListSchema)
  list() {
    return this.careers.listOpenJobs();
  }

  @Public()
  @Post("apply")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:job-apply")
  @Validate({ body: applySchema })
  @ResponseSchema(careersApplyResponseSchema)
  async apply(@Body() body: ApplyInput) {
    const result = await this.careers.apply(body);
    if (isApplyJobNotFound(result)) {
      throw new NotFoundException(
        "Job posting not found or is no longer accepting applications.",
      );
    }
    return result;
  }

  @Post("resumes/upload")
  @AuthorizedInService(
    "CareersService.uploadResume resolves the candidate by id AND the caller's orgId, and rejects when that pair does not exist",
  )
  @UseGuards(JwtAuthGuard)
  @ResponseSchema(uploadResumeResponseSchema)
  @MultipartAction({ file: "file", fields: { candidateId: "integer", fileName: "string", fileType: "string" }, requiredFields: ["candidateId", "fileName", "fileType"] })
  @UseInterceptors(FileInterceptor("file"))
  async uploadResume(
    @Req() req: Request & { user: { orgId: string; userId: string } },
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadResumeInput,
  ) {
    return this.careers.uploadResume(
      req.user.orgId,
      body.candidateId,
      req.user.userId,
      file.buffer,
      file.originalname,
      file.mimetype,
    );
  }
}
