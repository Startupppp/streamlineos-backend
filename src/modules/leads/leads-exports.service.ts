import { Inject, Injectable } from "@nestjs/common";
import { eq, and, or, ilike, isNull, sql, type SQL } from "drizzle-orm";

const EXPORT_ROW_CAP = 10_000;
import { users } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { findDuplicateLeads } from "./duplicate-leads";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
  LEAD_PARTY_SCOPE,
} from "./lead-party-reader";
import type { ScopedRead } from "../access/scoped-read";
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
      conditions.push(ilike(businessParties.email, query.email.trim()));
    }
    if (query.phone) {
      const normalized = query.phone.replace(/[\s\-+()]/g, "");
      const last10 = normalized.slice(-10);
      if (last10.length >= 10) {
        conditions.push(
          sql`REPLACE(REPLACE(REPLACE(${businessParties.phone}, ' ', ''), '-', ''), '+', '') LIKE ${"%" + last10}`,
        );
      }
    }

    if (conditions.length === 0) {
      return { duplicates: [] };
    }

    const duplicates = await this.db
      .select({
        id: LEAD_PARTY_COLUMNS.id,
        name: LEAD_PARTY_COLUMNS.name,
        email: LEAD_PARTY_COLUMNS.email,
        phone: LEAD_PARTY_COLUMNS.phone,
        company: LEAD_PARTY_COLUMNS.company,
        status: LEAD_PARTY_COLUMNS.status,
        createdAt: LEAD_PARTY_COLUMNS.createdAt,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      // Deleted records included, as this read has always included them: the
      // question is "has this person been entered before", and a deleted
      // duplicate is still a duplicate the person entering it should see.
      .where(and(...leadPartyScope(orgId, { includeDeleted: true }), or(...conditions)))
      .limit(5);

    return { duplicates };
  }

  async exportCsv(read: ScopedRead, filters: ExportQuery) {
    const orgId = read.orgId;
    // The caller may narrow to another rep only when their own scope already reaches beyond themselves; below `all` the scope predicate holds.
    const rows = await read.read(
      {
        tenant: businessParties.organizationId,
        scope: LEAD_PARTY_SCOPE,
        and: [
          eq(leadPartyMap.organizationId, orgId),
          isNull(businessParties.deletedAt),
          filters.status ? eq(LEAD_PARTY_COLUMNS.status, filters.status) : undefined,
          filters.priority ? eq(LEAD_PARTY_COLUMNS.priority, filters.priority) : undefined,
          filters.assigneeId ? eq(LEAD_PARTY_COLUMNS.assignedToId, filters.assigneeId) : undefined,
        ],
      },
      ({ sql: where }) => this.db
      .select({
        id: LEAD_PARTY_COLUMNS.id,
        name: LEAD_PARTY_COLUMNS.name,
        email: LEAD_PARTY_COLUMNS.email,
        phone: LEAD_PARTY_COLUMNS.phone,
        company: LEAD_PARTY_COLUMNS.company,
        city: LEAD_PARTY_COLUMNS.city,
        status: LEAD_PARTY_COLUMNS.status,
        priority: LEAD_PARTY_COLUMNS.priority,
        score: LEAD_PARTY_COLUMNS.score,
        source: LEAD_PARTY_COLUMNS.source,
        potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
        createdAt: LEAD_PARTY_COLUMNS.createdAt,
        assigneeName: users.name,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .leftJoin(users, eq(LEAD_PARTY_COLUMNS.assignedToId, users.id))
      .where(where)
      .orderBy(LEAD_PARTY_COLUMNS.createdAt, LEAD_PARTY_COLUMNS.id)
      .limit(EXPORT_ROW_CAP),
      () => [],
    );

    const truncated = rows.length === EXPORT_ROW_CAP;

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

    return { csv: [header, ...dataRows].join("\r\n"), truncated, rowCount: rows.length };
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
