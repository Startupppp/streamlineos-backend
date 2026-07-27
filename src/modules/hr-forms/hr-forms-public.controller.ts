import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Request,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { HrFormsService } from "./hr-forms.service";
import { HrFormsSubmissionsService } from "./hr-forms-submissions.service";
import { submitHrFormSchema, type SubmitHrFormInput } from "./dto/hr-forms.schemas";

@Controller("public/hr-forms")
export class HrFormsPublicController {
  constructor(
    private readonly svc: HrFormsService,
    private readonly submissions: HrFormsSubmissionsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ?? req.ip ?? "unknown";
  }

  private async enforceRateLimit(tier: string, identifier: string): Promise<void> {
    const result = await this.rateLimit.check(tier, identifier);
    if (!result.allowed) {
      throw new HttpException(
        { code: "HR_FORM_RATE_LIMITED", message: "Too many requests. Try again later.", details: { retryAfterSeconds: result.retryAfterSecs } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Public()
  @Get(":orgId/:slug")
  async getPublicForm(
    @Param("orgId") orgId: string,
    @Param("slug") slug: string,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("hr-form:public-view", this.getIp(req));
    const form = await this.svc.getFormBySlug(orgId, slug);
    if (form.audience !== "public" || form.status !== "active") {
      throw new NotFoundException("Form not found");
    }
    return {
      id: form.id,
      name: form.name,
      description: form.description,
      schema: form.schema.filter((f) => !f.sensitive),
    };
  }

  @Public()
  @Post(":orgId/:slug/submit")
  @HttpCode(201)
  async submitPublicForm(
    @Param("orgId") orgId: string,
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(submitHrFormSchema)) body: SubmitHrFormInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("hr-form:public-submit", this.getIp(req));
    const form = await this.svc.getFormBySlug(orgId, slug);
    if (form.audience !== "public" || form.status !== "active") {
      throw new NotFoundException("Form not found");
    }
    return this.submissions.submit(orgId, form.id, body, null, false);
  }
}
