import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { projectForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { SubmissionsService } from "../build/forms/submissions.service";
import type { PublicFormSubmitInput } from "./dto/public.schemas";

const FORM_COLUMNS = {
  id: true,
  name: true,
  description: true,
  type: true,
  fields: true,
  publicToken: true,
} as const;

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
        columns: FORM_COLUMNS,
      }),
    );
    if (!row) throw new NotFoundException("Form not found or no longer active");
    return row;
  }

  async getIntakeFormByProject(projectId: number) {
    const rows = await this.db.execute(
      sql`SELECT app.resolve_project_org_id(${projectId}) AS org_id`,
    );
    const orgId = rows[0]?.org_id ? String(rows[0].org_id) : null;
    if (!orgId) throw new NotFoundException("Project not found");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const row = await tx.query.projectForms.findFirst({
          where: and(
            eq(projectForms.projectId, projectId),
            eq(projectForms.orgId, orgId),
            eq(projectForms.isPublic, true),
            eq(projectForms.isActive, true),
            isNull(projectForms.deletedAt),
          ),
          columns: FORM_COLUMNS,
          orderBy: [desc(projectForms.createdAt)],
        });
        if (!row) throw new NotFoundException("No active public form for this project");
        return row;
      },
      { orgId },
    );
  }

  async submitByToken(token: string, input: PublicFormSubmitInput) {
    const submission = await this.submissions.submitPublicForm(token, input);
    return { id: submission.id, message: "Submission received successfully" };
  }
}
