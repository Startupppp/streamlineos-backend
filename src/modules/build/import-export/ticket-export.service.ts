import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { tickets } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { authorizeProjectTicketRead } from "../core";
import { ticketScope } from "../core/tickets";
import { EXPORT_MAX_ROWS } from "./import-export.constants";
import { toCsv } from "./csv-source";
import { TICKET_IMPORT_FIELDS } from "./dto/ticket-import.schemas";
import type { ImportFormat } from "./import-source";

export const TICKET_EXPORT_COLUMNS = ["ticketNumber", ...TICKET_IMPORT_FIELDS] as const;

type TicketExportColumn = (typeof TICKET_EXPORT_COLUMNS)[number];

export type TicketExportRecord = Record<TicketExportColumn, unknown>;

export interface TicketExportResult {
  format: ImportFormat;
  filename: string;
  contentType: string;
  rowCount: number;
  content: string;
}

export interface TicketExportInput {
  format: ImportFormat;
  limit?: number;
  ticketIds?: number[];
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

@Injectable()
export class TicketExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async exportTickets(
    u: CurrentUserContext,
    projectId: number,
    input: TicketExportInput,
  ): Promise<TicketExportResult> {
    const read = await authorizeProjectTicketRead(this.db, this.access, u, projectId);
    const limit = Math.min(Math.max(input.limit ?? EXPORT_MAX_ROWS, 1), EXPORT_MAX_ROWS);
    const requestedIds = [...new Set(input.ticketIds ?? [])];

    const rows = await read.read(
      {
        tenant: tickets.orgId,
        scope: ticketScope(read.orgId, read.actorId),
        and: [
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
          ...(requestedIds.length > 0 ? [inArray(tickets.id, requestedIds)] : []),
        ],
      },
      (where) =>
        this.db
          .select({
            ticketNumber: tickets.ticketNumber,
            title: tickets.title,
            description: tickets.description,
            type: tickets.type,
            status: tickets.status,
            priority: tickets.priority,
            startDate: tickets.startDate,
            dueDate: tickets.dueDate,
            points: tickets.points,
            storyPoints: tickets.points,
            estimate: tickets.estimate,
            completionPercentage: tickets.completionPercentage,
            clientVisible: tickets.clientVisible,
            link: tickets.link,
          })
          .from(tickets)
          .where(and(where.sql))
          .orderBy(asc(tickets.ticketNumber))
          .limit(Math.max(limit, requestedIds.length)),
      () => [] as TicketExportRecord[],
    );
    if (requestedIds.length > 0 && rows.length !== requestedIds.length)
      throw new NotFoundException("One or more ticket IDs not found in this project");

    const records = rows as TicketExportRecord[];
    const exported = records.slice(0, limit);
    return {
      format: input.format,
      filename: `build-project-${projectId}-tickets.${input.format}`,
      contentType: input.format === "csv" ? "text/csv" : "application/json",
      rowCount: exported.length,
      content:
        input.format === "csv" ? this.toCsvContent(exported) : JSON.stringify(exported, null, 2),
    };
  }

  private toCsvContent(records: readonly TicketExportRecord[]): string {
    const header = [...TICKET_EXPORT_COLUMNS];
    const body = records.map((record) => header.map((column) => cell(record[column])));
    return toCsv([header, ...body]);
  }
}
