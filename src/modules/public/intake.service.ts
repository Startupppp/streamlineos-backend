import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { intakeItems, projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { sanitizeText } from "./public.helpers";
import type { IntakeInput } from "./dto/public.schemas";

@Injectable()
export class IntakeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async submitIntake(projectId: number, input: IntakeInput) {
    const [project] = await this.db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project) throw new BadRequestException("Invalid request");

    const sanitizedTitle = sanitizeText(input.title);
    const sanitizedDescription = input.description
      ? sanitizeText(input.description)
      : undefined;

    const [item] = await this.db
      .insert(intakeItems)
      .values({
        projectId,
        orgId: project.orgId,
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
      })
      .returning({ id: intakeItems.id });

    return { id: item.id, message: "Request submitted successfully" };
  }
}
