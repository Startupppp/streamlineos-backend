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
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { CareersService, isApplyJobNotFound } from "./careers.service";
import { applySchema, type ApplyInput } from "./dto/careers.schemas";
import { uploadResumeSchema, type UploadResumeInput } from "./dto/resumes.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { careersJobListSchema, careersApplyResponseSchema } from "./dto/careers-response.schemas";
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
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadResume(
    @Req() req: Request & { user: { orgId: string, userId: string } },
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadResumeInput,
  ) {
    return this.careers.uploadResume(
        req.user.orgId,
        body.candidateId,
        req.user.userId,
        file.buffer,
        file.originalname,
        file.mimetype
    );
  }
}
