import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { projectForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { SubmissionsService } from "../build/forms/submissions.service";
import type { PublicFormSubmitInput } from "./dto/public.schemas";

@Injectable()
export class PublicFormsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly submissions: SubmissionsService,
  ) {}

  async getFormByToken(token: string) {
    const row = await withPublicToken(this.db, token, (tx) =>
      tx.query.projectForms.findFirst({
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
      }),
    );
    if (!row) throw new NotFoundException("Form not found or no longer active");
    return row;
  }

  async submitByToken(token: string, input: PublicFormSubmitInput) {
    const submission = await this.submissions.submitPublicForm(token, input);
    return { id: submission.id, message: "Submission received successfully" };
  }
}
