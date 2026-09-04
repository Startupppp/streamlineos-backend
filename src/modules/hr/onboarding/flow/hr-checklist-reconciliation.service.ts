import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { moduleSetupChecklistItems } from "../../../../db/schema";
import { HR_SIGNAL_KEYS, computeHrSignals, type HrSignalKey } from "./hr-checklist-signals";

type ChecklistItemRow = typeof moduleSetupChecklistItems.$inferSelect;

/**
 * Derives HR setup-checklist item completion from real HR data instead of manual complete
 * clicks (task requirement: "completion should be calculated from real data"). Called by
 * ModuleChecklistService on every HR checklist read.
 */
@Injectable()
export class HrChecklistReconciliationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Applies auto-detected status to every non-skipped, non-blocked item. Returns true if anything changed. */
  async reconcile(orgId: string, items: ChecklistItemRow[]): Promise<boolean> {
    const signals = await computeHrSignals(this.db, orgId);
    const nowDone: number[] = [];
    const nowTodo: number[] = [];

    for (const item of items) {
      if (!this.isHrSignalKey(item.itemKey)) continue;
      if (item.status === "skipped" || item.status === "blocked") continue;

      const satisfied = signals[item.itemKey];
      if (satisfied && item.status !== "done") nowDone.push(item.id);
      else if (!satisfied && item.status === "done") nowTodo.push(item.id);
    }

    if (nowDone.length > 0) {
      await this.db
        .update(moduleSetupChecklistItems)
        .set({ status: "done", completedAt: new Date() })
        .where(
          and(
            eq(moduleSetupChecklistItems.orgId, orgId),
            inArray(moduleSetupChecklistItems.id, nowDone),
          ),
        );
    }

    if (nowTodo.length > 0) {
      await this.db
        .update(moduleSetupChecklistItems)
        .set({ status: "todo", completedAt: null })
        .where(
          and(
            eq(moduleSetupChecklistItems.orgId, orgId),
            inArray(moduleSetupChecklistItems.id, nowTodo),
          ),
        );
    }

    return nowDone.length > 0 || nowTodo.length > 0;
  }

  private isHrSignalKey(itemKey: string): itemKey is HrSignalKey {
    return (HR_SIGNAL_KEYS as readonly string[]).includes(itemKey);
  }
}
