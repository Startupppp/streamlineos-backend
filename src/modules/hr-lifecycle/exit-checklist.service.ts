import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { hrTemplates, exitChecklists } from "../../db/schema";

type ChecklistItem = { title: string; assigneeRole?: string; dueOffsetDays?: number; required?: boolean; order?: number };
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

const DEFAULT_CHECKLIST_ITEMS = [
  "Return company assets",
  "Revoke system access",
  "Complete knowledge transfer",
  "Submit final timesheet",
  "Exit interview scheduled",
] as const;

@Injectable()
export class ExitChecklistService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async seedChecklistFromTemplate(
    orgId: string,
    resignationId: number,
  ): Promise<{ created: number }> {
    const template = await this.db.query.hrTemplates.findFirst({
      where: and(
        eq(hrTemplates.orgId, orgId),
        eq(hrTemplates.kind, "offboarding_checklist"),
        eq(hrTemplates.status, "active"),
        isNull(hrTemplates.deletedAt),
      ),
      orderBy: [desc(hrTemplates.updatedAt)],
      columns: { id: true, content: true },
    });

    if (template) {
      const content = template.content as { items?: unknown[] };
      const rawItems = Array.isArray(content.items) ? content.items : [];
      const items = rawItems.filter(
        (i): i is ChecklistItem =>
          i !== null &&
          typeof i === "object" &&
          typeof (i as Record<string, unknown>)["title"] === "string",
      );

      if (items.length > 0) {
        await this.db.insert(exitChecklists).values(
          items.map((ci) => ({
            orgId,
            resignationId,
            item: ci.title,
            status: "PENDING" as const,
          })),
        );
        return { created: items.length };
      }
    }

    await this.db.insert(exitChecklists).values(
      DEFAULT_CHECKLIST_ITEMS.map((item) => ({
        orgId,
        resignationId,
        item,
        status: "PENDING" as const,
      })),
    );

    return { created: DEFAULT_CHECKLIST_ITEMS.length };
  }
}
