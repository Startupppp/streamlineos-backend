import {
  Body,
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Validate } from "../../common/validation/validate.decorator";
import { CareersService } from "./careers.service";
import { uploadResumeSchema, type UploadResumeInput } from "./dto/resumes.schemas";
import { MultipartAction } from "../../common/openapi/zod-operation-contracts";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import type { Request } from "express";

/**
 * What is left of the legacy careers surface after the apply door was collapsed
 * onto `POST /public/careers/:orgSlug/jobs/:jobId/apply`.
 *
 * `GET /careers` listed every organisation's open jobs with no org slug — one
 * unauthenticated request returned the hiring plans of every tenant on the
 * platform — and `POST /careers/apply` was a second, weaker apply that took a
 * bare `jobPostingId` and so inferred the tenant from the id. Both are gone.
 * The org-scoped endpoint now does everything the legacy one did (consent,
 * screening answers, `candidate.applied`) and everything it did not.
 *
 * The authenticated résumé upload stays: it is a recruiter attaching a file to
 * a candidate that already exists, which is not an apply at all.
 */
@Controller("careers")
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Post("resumes/upload")
  @AuthorizedInService(
    "CareersService.uploadResume resolves the candidate by id AND the caller's orgId, and rejects when that pair does not exist",
  )
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor("file"))
  @MultipartAction({ file: "file", fields: { candidateId: "integer" }, requiredFields: ["candidateId"] })
  @Validate({ body: uploadResumeSchema })
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
