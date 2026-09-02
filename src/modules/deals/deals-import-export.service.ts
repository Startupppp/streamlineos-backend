import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";

const EXPORT_ROW_CAP = 10_000;
import { deals, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { toCsv } from "../inventory/import-export/csv.util";
import { DealsCrudService } from "./deals-crud.service";
import type { BulkImportDealsInput } from "./dto/deals.schemas";
import type { DataScope } from "../access/access.types";
import { applyScope } from "../access/apply-scope";

@Injectable()
export class DealsImportExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly crud: DealsCrudService,
  ) {}

  async bulkImport(orgId: string, userId: string, input: BulkImportDealsInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmDeals", input.deals.length);

    const ownerEmails = Array.from(
      new Set(
        input.deals
          .map((d) => d.ownerEmail?.trim().toLowerCase())
          .filter((e): e is string => !!e),
      ),
    );

    const emailToUserId = new Map<string, string>();
    if (ownerEmails.length > 0) {
      const members = await this.db
        .select({ userId: organizationMembers.userId, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.orgId, orgId));
      for (const m of members) {
        if (m.email) emailToUserId.set(m.email.toLowerCase(), m.userId);
      }
    }

    let created = 0;
    let failed = 0;

    for (const row of input.deals) {
      try {
        const ownerEmail = row.ownerEmail?.trim().toLowerCase();
        const assignedToId =
          (ownerEmail ? emailToUserId.get(ownerEmail) : undefined) ?? userId;

        const noteParts: string[] = [];
        if (row.companyName?.trim()) noteParts.push(`Company: ${row.companyName.trim()}`);
        if (row.description?.trim()) noteParts.push(row.description.trim());
        const notes = noteParts.length > 0 ? noteParts.join("\n") : undefined;

        const expectedCloseDate = row.expectedCloseDate?.trim() || undefined;
        let closeDate: string | undefined;
        if (expectedCloseDate) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(expectedCloseDate)) {
            closeDate = expectedCloseDate;
          } else {
            const parsed = new Date(expectedCloseDate);
            if (!Number.isNaN(parsed.getTime())) {
              closeDate = parsed.toISOString().split("T")[0];
            }
          }
        }

        await this.crud.createDeal(orgId, userId, {
          name: row.name.trim(),
          value: row.value,
          stage: row.stage?.trim() || undefined,
          contactEmail: row.contactEmail?.trim() || undefined,
          assignedToId,
          expectedCloseDate: closeDate,
          notes,
        });
        created++;
      } catch (err) {
        logSideEffectFailure("deals-import: deal create", { orgId })(err);
        failed++;
      }
    }

    return { created, failed };
  }

  async exportCsv(orgId: string, userId: string, scope: DataScope): Promise<{ csv: string; truncated: boolean; rowCount: number }> {
    const headers = [
      "id",
      "name",
      "value",
      "stage",
      "probability",
      "contactEmail",
      "contactPerson",
      "expectedCloseDate",
      "assignee",
      "notes",
      "createdAt",
    ];
    if (scope === "none") return { csv: toCsv(headers, []), truncated: false, rowCount: 0 };
    const rows = await this.db
      .select({
        id: deals.id,
        name: deals.name,
        value: deals.value,
        stage: deals.stage,
        probability: deals.probability,
        contactEmail: deals.contactEmail,
        contactPerson: deals.contactPerson,
        expectedCloseDate: deals.expectedCloseDate,
        notes: deals.notes,
        assigneeName: users.name,
        createdAt: deals.createdAt,
      })
      .from(deals)
      .leftJoin(users, eq(deals.assignedToId, users.id))
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), applyScope(scope, orgId, userId, { ownerColumn: deals.assignedToId })))
      .orderBy(desc(deals.updatedAt))
      .limit(EXPORT_ROW_CAP);

    const truncated = rows.length === EXPORT_ROW_CAP;
    return {
      csv: toCsv(
        headers,
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          value: r.value ?? "0",
          stage: r.stage,
          probability: r.probability ?? 0,
          contactEmail: r.contactEmail ?? "",
          contactPerson: r.contactPerson ?? "",
          expectedCloseDate: r.expectedCloseDate ?? "",
          assignee: r.assigneeName ?? "",
          notes: r.notes ?? "",
          createdAt: r.createdAt?.toISOString() ?? "",
        })),
      ),
      truncated,
      rowCount: rows.length,
    };
  }
}
