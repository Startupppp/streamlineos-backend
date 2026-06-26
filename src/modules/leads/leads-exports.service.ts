import { Inject, Injectable } from "@nestjs/common";
import { eq, and, or, ilike, sql, type SQL } from "drizzle-orm";
import { leads, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { findDuplicateLeads } from "./duplicate-leads";
import type { CheckDuplicatesQuery, ExportQuery } from "./dto/lead-reports.schemas";

@Injectable()
export class LeadsExportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getDuplicates(orgId: string) {
    const groups = await findDuplicateLeads(this.db, orgId);
    return { groups, total: groups.length };
  }

  async checkDuplicates(orgId: string, query: CheckDuplicatesQuery) {
    if (!query.email && !query.phone) {
      return { duplicates: [] };
    }

    const conditions: SQL[] = [];
    if (query.email) {
      conditions.push(ilike(leads.email, query.email.trim()));
    }
    if (query.phone) {
      const normalized = query.phone.replace(/[\s\-+()]/g, "");
      const last10 = normalized.slice(-10);
      if (last10.length >= 10) {
        conditions.push(
          sql`REPLACE(REPLACE(REPLACE(${leads.phone}, ' ', ''), '-', ''), '+', '') LIKE ${"%" + last10}`,
        );
      }
    }

    if (conditions.length === 0) {
      return { duplicates: [] };
    }

    const duplicates = await this.db
      .select({
        id: leads.id,
        name: leads.name,
        email: leads.email,
        phone: leads.phone,
        company: leads.company,
        status: leads.status,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), or(...conditions)))
      .limit(5);

    return { duplicates };
  }

  async exportCsv(orgId: string, filters: ExportQuery) {
    const conditions = [eq(leads.orgId, orgId)];
    if (filters.status) conditions.push(eq(leads.status, filters.status));
    if (filters.priority) conditions.push(eq(leads.priority, filters.priority));
    if (filters.assigneeId) conditions.push(eq(leads.assignedToId, filters.assigneeId));

    const rows = await this.db
      .select({
        id: leads.id,
        name: leads.name,
        email: leads.email,
        phone: leads.phone,
        company: leads.company,
        city: leads.city,
        status: leads.status,
        priority: leads.priority,
        score: leads.score,
        source: leads.source,
        potentialValue: leads.potentialValue,
        createdAt: leads.createdAt,
        assigneeName: users.name,
      })
      .from(leads)
      .leftJoin(users, eq(leads.assignedToId, users.id))
      .where(and(...conditions))
      .orderBy(leads.createdAt);

    const header = toRow([
      "ID",
      "Name",
      "Email",
      "Phone",
      "Company",
      "City",
      "Stage",
      "Priority",
      "Score",
      "Source",
      "Potential Value",
      "Assigned To",
      "Created At",
    ]);

    const dataRows = rows.map((r) =>
      toRow([
        r.id,
        r.name,
        r.email,
        r.phone,
        r.company,
        r.city,
        r.status,
        r.priority,
        r.score,
        r.source,
        r.potentialValue,
        r.assigneeName,
        r.createdAt ? new Date(r.createdAt).toISOString() : "",
      ]),
    );

    return [header, ...dataRows].join("\r\n");
  }
}

function escapeCell(value: string | number | null | undefined): string {
  const str = value == null ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(escapeCell).join(",");
}
