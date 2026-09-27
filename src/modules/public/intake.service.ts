import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { intakeItems, projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { sanitizeText } from "./public.helpers";
import type { IntakeInput } from "./dto/public.schemas";

@Injectable()
export class IntakeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async submitIntake(projectId: number, input: IntakeInput) {
    const rows = await this.db.execute(
      sql`SELECT app.resolve_project_org_id(${projectId}) AS org_id`,
    );
    const orgId = rows[0]?.org_id ? String(rows[0].org_id) : null;

    if (!orgId) throw new BadRequestException("Invalid request");

    return this.executeSubmission(projectId, orgId, input);
  }

  async submitIntakeByToken(token: string, input: IntakeInput) {
    const rows = await this.db.execute(
      sql`SELECT project_id, org_id FROM app.resolve_project_org_id_by_intake_token(${token})`,
    );
    const row = rows[0];
    const projectId = row?.project_id != null ? Number(row.project_id) : null;
    const orgId = row?.org_id ? String(row.org_id) : null;

    if (!projectId || !orgId) throw new BadRequestException("Invalid request");

    return this.executeSubmission(projectId, orgId, input);
  }

  private async executeSubmission(projectId: number, orgId: string, input: IntakeInput) {
    const sanitizedTitle = sanitizeText(input.title);
    const sanitizedDescription = input.description
      ? sanitizeText(input.description)
      : undefined;

    const item = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [project] = await tx
          .select({ id: projects.id, intakePublishedAt: projects.intakePublishedAt })
          .from(projects)
          .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
          .limit(1);
        if (!project) return null;
        if (project.intakePublishedAt == null) return null;

        const [inserted] = await tx
          .insert(intakeItems)
          .values({
            projectId,
            orgId,
            title: sanitizedTitle,
            description: sanitizedDescription
              ? {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: sanitizedDescription }],
                    },
                  ],
                }
              : null,
            source: "web_form",
            submitterEmail: input.submitterEmail ?? null,
            submitterName: input.submitterName ?? null,
            priority: input.priority ?? null,
            requestType: input.requestType ?? null,
          })
          .returning({ id: intakeItems.id });
        return inserted;
      },
      { orgId },
    );

    if (!item) throw new BadRequestException("Invalid request");

    return { message: "Request submitted successfully" };
  }
}
