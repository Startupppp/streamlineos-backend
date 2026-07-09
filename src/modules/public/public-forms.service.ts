import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { formSubmissions, projectForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { PublicFormSubmitInput } from "./dto/public.schemas";

@Injectable()
export class PublicFormsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getFormByToken(token: string) {
    const row = await this.db.query.projectForms.findFirst({
      where: and(
        eq(projectForms.publicToken, token),
        eq(projectForms.isPublic, true),
        eq(projectForms.isActive, true),
        isNull(projectForms.deletedAt),
      ),
      columns: {
        id: true,
        name: true,
        description: true,
        type: true,
        fields: true,
      },
    });
    if (!row) throw new NotFoundException("Form not found or no longer active");
    return row;
  }

  async submitByToken(token: string, input: PublicFormSubmitInput) {
    const form = await this.db.query.projectForms.findFirst({
      where: and(
        eq(projectForms.publicToken, token),
        eq(projectForms.isPublic, true),
        eq(projectForms.isActive, true),
        isNull(projectForms.deletedAt),
      ),
      columns: {
        id: true,
        orgId: true,
        projectId: true,
        isActive: true,
      },
    });
    if (!form) throw new NotFoundException("Form not found or no longer active");
    if (!form.isActive) throw new BadRequestException("Form is not accepting submissions");

    const [submission] = await this.db
      .insert(formSubmissions)
      .values({
        orgId: form.orgId,
        formId: form.id,
        projectId: form.projectId,
        values: input.values,
        status: "submitted",
        submittedByName: input.submittedByName ?? null,
        submittedById: null,
      })
      .returning({ id: formSubmissions.id });

    if (!submission) throw new BadRequestException("Failed to create submission");
    return { id: submission.id, message: "Submission received successfully" };
  }
}
