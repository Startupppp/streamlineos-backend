import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { projectForms, projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { SubmissionsService } from "../build/forms/submissions.service";
import type { PublicFormSubmitInput } from "./dto/public.schemas";

const FORM_LIFECYCLE_COLUMNS = {
  id: true,
  name: true,
  description: true,
  type: true,
  fields: true,
  publicToken: true,
  isPublic: true,
  isActive: true,
  deletedAt: true,
} as const;

@Injectable()
export class PublicFormsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly submissions: SubmissionsService,
  ) {}

  async getFormByToken(token: string) {
    const raw = await withPublicToken(this.db, token, (tx) =>
      tx.query.projectForms.findFirst({
        where: eq(projectForms.publicToken, token),
        columns: FORM_LIFECYCLE_COLUMNS,
      }),
    );
    if (!raw) throw new NotFoundException("Form not found or no longer active");
    if (raw.deletedAt !== null) throw new NotFoundException("Form not found or no longer active");
    if (!raw.isPublic) throw new NotFoundException("Form not found or no longer active");
    if (!raw.isActive) throw new NotFoundException("Form not found or no longer active");
    return {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      type: raw.type,
      fields: raw.fields,
      publicToken: raw.publicToken,
    };
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
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
          .limit(1);
        if (!project) throw new NotFoundException("Project not found");

        const raw = await tx.query.projectForms.findFirst({
          where: and(
            eq(projectForms.projectId, projectId),
            eq(projectForms.orgId, orgId),
            eq(projectForms.isPublic, true),
            eq(projectForms.isActive, true),
            isNull(projectForms.deletedAt),
          ),
          columns: FORM_LIFECYCLE_COLUMNS,
          orderBy: [desc(projectForms.createdAt)],
        });
        if (!raw) throw new NotFoundException("No active public form for this project");
        return {
          id: raw.id,
          name: raw.name,
          description: raw.description,
          type: raw.type,
          fields: raw.fields,
          publicToken: raw.publicToken,
        };
      },
      { orgId },
    );
  }

  async submitByToken(token: string, input: PublicFormSubmitInput) {
    const submission = await this.submissions.submitPublicForm(token, input);
    return { id: submission.id, message: "Submission received successfully" };
  }
}
