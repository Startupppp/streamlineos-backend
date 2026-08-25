import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities, businessParties, partyContacts, subjects } from "../../db/schema";

/**
 * Getting everything back out again.
 *
 * Deliberately ungated. Making departure easy is the argument against
 * incumbents who make it deliberately hard, and an export behind a plan tier is
 * the same lock-in with a nicer name. There is no entitlement check in this
 * file and there should never be one.
 *
 * Custom fields and activity history are included for the same reason: an
 * export that omits the parts a tenant typed themselves is not an export, it is
 * a sample.
 */

/** A page at a time, so a large tenant does not become one enormous statement. */
const PAGE = 1_000;
const MAX_ROWS = 50_000;

export type ExportEntity = "parties" | "contacts" | "subjects" | "activities";
export const EXPORT_ENTITIES: readonly ExportEntity[] = [
  "parties",
  "contacts",
  "subjects",
  "activities",
];

@Injectable()
export class CrmExportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async rowsFor(
    organizationId: string,
    entity: ExportEntity,
  ): Promise<Record<string, unknown>[]> {
    switch (entity) {
      case "parties":
        return this.page((offset) =>
          this.db
            .select()
            .from(businessParties)
            .where(
              and(
                eq(businessParties.organizationId, organizationId),
                isNull(businessParties.deletedAt),
              ),
            )
            .orderBy(asc(businessParties.partyId))
            .limit(PAGE)
            .offset(offset),
        );

      case "contacts":
        return this.page((offset) =>
          this.db
            .select()
            .from(partyContacts)
            .where(
              and(
                eq(partyContacts.organizationId, organizationId),
                isNull(partyContacts.deletedAt),
              ),
            )
            .orderBy(asc(partyContacts.partyContactId))
            .limit(PAGE)
            .offset(offset),
        );

      case "subjects":
        return this.page((offset) =>
          this.db
            .select()
            .from(subjects)
            .where(and(eq(subjects.organizationId, organizationId), isNull(subjects.deletedAt)))
            .orderBy(asc(subjects.subjectId))
            .limit(PAGE)
            .offset(offset),
        );

      case "activities":
        return this.page((offset) =>
          this.db
            .select()
            .from(activities)
            .where(
              and(eq(activities.organizationId, organizationId), isNull(activities.deletedAt)),
            )
            .orderBy(asc(activities.activityId))
            .limit(PAGE)
            .offset(offset),
        );
    }
  }

  /** Everything, as one document. */
  async archive(organizationId: string): Promise<Record<ExportEntity, Record<string, unknown>[]>> {
    const entries = await Promise.all(
      EXPORT_ENTITIES.map(async (entity) => [entity, await this.rowsFor(organizationId, entity)] as const),
    );
    return Object.fromEntries(entries) as Record<ExportEntity, Record<string, unknown>[]>;
  }

  private async page(
    query: (offset: number) => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const rows = await query(offset);
      all.push(...rows);
      if (rows.length < PAGE) break;
    }
    return all;
  }
}

/**
 * CSV that survives a round trip.
 *
 * The rules here are the ones people actually get wrong: a value containing a
 * comma, a quote or a newline has to be quoted and its quotes doubled, or the
 * file silently gains columns when it is read back. A JSONB column is written
 * as JSON rather than as `[object Object]`.
 */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";

  // Union of keys, not the first row's: a nullable column absent from row one
  // would otherwise drop out of the file entirely.
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];

  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));

  return lines.join("\n");
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
