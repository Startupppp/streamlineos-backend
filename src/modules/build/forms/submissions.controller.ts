import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Public } from "../../../common/auth/public.decorator";
import { SubmissionsService } from "./submissions.service";
import {
  createSubmissionSchema,
  listSubmissionsQuerySchema,
  updateSubmissionSchema,
  type CreateSubmissionInput,
  type ListSubmissionsQuery,
  type UpdateSubmissionInput,
} from "./dto/forms.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  publicSubmissionResultSchema,
  submissionCreateResultSchema,
  submissionRowSchema,
} from "./dto/forms-response.schemas";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { resolveClientIpOr, type ClientAddressed } from "../../../common/http/client-ip";

const submissionIdParams = z.object({
  projectId: z.coerce.number().int().positive(),
  formId: z.coerce.number().int().positive(),
  submissionId: z.coerce.number().int().positive(),
}).strict();

const publicTokenParams = z.object({ publicToken: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("build/:projectId/forms/:formId/submissions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SubmissionsController {
  constructor(private readonly svc: SubmissionsService) {}

  @Get()
  @RequirePermission("build:forms:manage")
  @ResponseSchema(z.array(submissionRowSchema))
  @Validate({ query: listSubmissionsQuerySchema })
  listSubmissions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Query() query: ListSubmissionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listSubmissions(u.orgId, projectId, formId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:forms:view")
  @ResponseSchema(submissionCreateResultSchema)
  @Validate({ body: createSubmissionSchema })
  createSubmission(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Body() body: CreateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createSubmission(u.orgId, u.userId, projectId, formId, body);
  }

  @Patch(":submissionId")
  @RequirePermission("build:forms:manage")
  @ResponseSchema(submissionRowSchema)
  @Validate({ params: submissionIdParams, body: updateSubmissionSchema })
  updateSubmission(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("formId", ParseIntPipe) formId: number,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body() body: UpdateSubmissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateSubmission(u.orgId, u.userId, projectId, formId, submissionId, body);
  }
}

@Controller("public/build-forms")
export class SubmissionsPublicController {
  constructor(
    private readonly svc: SubmissionsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Post(":publicToken/submissions")
  @HttpCode(201)
  @ResponseSchema(publicSubmissionResultSchema)
  @Validate({ params: publicTokenParams, body: createSubmissionSchema })
  async submitPublicForm(
    @Param("publicToken") publicToken: string,
    @Body() body: CreateSubmissionInput,
    @Request() req: ClientAddressed,
  ) {
    const ip = resolveClientIpOr(req, "unknown");
    const rateLimitResult = await this.rateLimit.check("public:form-submit", ip);
    if (!rateLimitResult.allowed) {
      throw new HttpException(
        { code: "FORM_RATE_LIMITED", message: "Too many requests. Try again later.", details: { retryAfterSeconds: rateLimitResult.retryAfterSecs } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.svc.submitPublicForm(publicToken, body);
  }
}
