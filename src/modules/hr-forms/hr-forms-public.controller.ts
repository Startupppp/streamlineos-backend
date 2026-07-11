import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrFormsService } from "./hr-forms.service";
import { HrFormsSubmissionsService } from "./hr-forms-submissions.service";
import { submitHrFormSchema, type SubmitHrFormInput } from "./dto/hr-forms.schemas";

@Controller("public/hr-forms")
export class HrFormsPublicController {
  constructor(
    private readonly svc: HrFormsService,
    private readonly submissions: HrFormsSubmissionsService,
  ) {}

  @Get(":orgId/:slug")
  async getPublicForm(
    @Param("orgId") orgId: string,
    @Param("slug") slug: string,
  ) {
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

  @Post(":orgId/:slug/submit")
  @HttpCode(201)
  async submitPublicForm(
    @Param("orgId") orgId: string,
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(submitHrFormSchema)) body: SubmitHrFormInput,
  ) {
    const form = await this.svc.getFormBySlug(orgId, slug);
    if (form.audience !== "public" || form.status !== "active") {
      throw new NotFoundException("Form not found");
    }
    return this.submissions.submit(orgId, form.id, body, null, false);
  }
}
