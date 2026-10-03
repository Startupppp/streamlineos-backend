import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNull, lte, ne, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { projects, timesheets } from "../../../db/schema";
import {
  SAFE_INVOICE_LINE_DETAIL,
  safestInvoiceLineDetail,
  type InvoiceLineDetail,
} from "./invoice-line-detail";

export const INVOICEABLE_ENTRY_CAP = 100;

export interface InvoiceableTimesheetEntry {
  id: number;
  projectId: number | null;
  projectName: string | null;
  date: string;
  hours: string;
  billRate: string | null;
  currency: string | null;
  description: string | null;
}

export interface UninvoicedTimesheetEntry extends InvoiceableTimesheetEntry {
  invoiceLineDetail: InvoiceLineDetail | null;
  /**
   * In practice `UNINVOICED` or `INVOICE_DRAFTED` — the query this populates
   * from always excludes `INVOICED` — typed as the full column enum rather
   * than narrowed, since narrowing it would need an assertion the query
   * result can't back statically (root CLAUDE.md §6 bans `as X` outright).
   * Surfaced so a caller (the billing queue UI) can tell a plain billable
   * entry from one stranded at `INVOICE_DRAFTED` by a `createInvoiceDraft`
   * export that never became a real invoice, and offer to release it
   * (`POST /timesheets/billing/release-draft`).
   */
  invoicingStatus: "UNINVOICED" | "INVOICE_DRAFTED" | "INVOICED";
}

@Injectable()
export class TimesheetInvoicingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadInvoiceableEntries(
    orgId: string,
    entryIds: readonly number[],
  ): Promise<InvoiceableTimesheetEntry[]> {
    const wanted = [...new Set(entryIds)];
    if (wanted.length === 0) return [];
    if (wanted.length > INVOICEABLE_ENTRY_CAP)
      throw new BadRequestException(
        `At most ${INVOICEABLE_ENTRY_CAP} timesheet entries can be billed on one invoice`,
      );

    const rows = await this.db
      .select({
        id: timesheets.id,
        projectId: timesheets.projectId,
        projectName: projects.name,
        date: timesheets.date,
        hours: timesheets.hours,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        description: timesheets.description,
        status: timesheets.status,
        isBillable: timesheets.isBillable,
        invoicingStatus: timesheets.invoicingStatus,
        voidedAt: timesheets.voidedAt,
      })
      .from(timesheets)
      .leftJoin(
        projects,
        and(eq(projects.id, timesheets.projectId), eq(projects.orgId, orgId)),
      )
      .where(and(eq(timesheets.orgId, orgId), inArray(timesheets.id, wanted)))
      .orderBy(asc(timesheets.date), asc(timesheets.id))
      .limit(INVOICEABLE_ENTRY_CAP);

    const found = new Set(rows.map((row) => row.id));
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length > 0)
      throw new NotFoundException(
        `Timesheet entry not found: ${missing.join(", ")}`,
      );

    const voided = rows.filter((row) => row.voidedAt !== null);
    if (voided.length > 0)
      throw new BadRequestException(
        `Timesheet entry has been voided and cannot be invoiced: ${voided.map((r) => r.id).join(", ")}`,
      );

    const unapproved = rows.filter((row) => row.status !== "APPROVED");
    if (unapproved.length > 0)
      throw new BadRequestException(
        `Timesheet entry is not approved and cannot be invoiced: ${unapproved.map((r) => r.id).join(", ")}`,
      );

    const nonBillable = rows.filter((row) => !row.isBillable);
    if (nonBillable.length > 0)
      throw new BadRequestException(
        `Timesheet entry is not billable: ${nonBillable.map((r) => r.id).join(", ")}`,
      );

    const alreadyInvoiced = rows.filter(
      (row) => row.invoicingStatus === "INVOICED",
    );
    if (alreadyInvoiced.length > 0)
      throw new ConflictException(
        `Timesheet entry has already been invoiced: ${alreadyInvoiced.map((r) => r.id).join(", ")}`,
      );

    const unrated = rows.filter((row) => row.billRate === null);
    if (unrated.length > 0)
      throw new BadRequestException(
        `Timesheet entry has no bill rate and cannot be priced: ${unrated.map((r) => r.id).join(", ")}`,
      );

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      projectName: row.projectName,
      date: row.date,
      hours: row.hours,
      billRate: row.billRate,
      currency: row.currency,
      description: row.description,
    }));
  }

  async listUninvoicedEntries(
    orgId: string,
    query: {
      startDate?: string | undefined;
      endDate?: string | undefined;
      projectId?: number | undefined;
      limit: number;
    },
  ): Promise<UninvoicedTimesheetEntry[]> {
    const conditions: SQL[] = [
      eq(timesheets.orgId, orgId),
      eq(timesheets.status, "APPROVED"),
      eq(timesheets.isBillable, true),
      isNull(timesheets.voidedAt),
      ne(timesheets.invoicingStatus, "INVOICED"),
    ];
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.projectId !== undefined)
      conditions.push(eq(timesheets.projectId, query.projectId));

    const rows = await this.db
      .select({
        id: timesheets.id,
        projectId: timesheets.projectId,
        projectName: projects.name,
        date: timesheets.date,
        hours: timesheets.hours,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        description: timesheets.description,
        invoiceLineDetail: projects.invoiceLineDetail,
        invoicingStatus: timesheets.invoicingStatus,
      })
      .from(timesheets)
      .leftJoin(
        projects,
        and(eq(projects.id, timesheets.projectId), eq(projects.orgId, orgId)),
      )
      .where(and(...conditions))
      .orderBy(asc(timesheets.date), asc(timesheets.id))
      .limit(Math.min(query.limit, INVOICEABLE_ENTRY_CAP));

    return rows;
  }

  async resolveInvoiceLineDetail(
    tx: TenantTx,
    orgId: string,
    projectIds: readonly (number | null)[],
  ): Promise<InvoiceLineDetail> {
    if (projectIds.length === 0) return SAFE_INVOICE_LINE_DETAIL;
    if (projectIds.some((projectId) => projectId === null))
      return SAFE_INVOICE_LINE_DETAIL;

    const wanted = [
      ...new Set(projectIds.filter((id): id is number => id !== null)),
    ];

    const rows = await tx
      .select({ invoiceLineDetail: projects.invoiceLineDetail })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          inArray(projects.id, wanted),
          isNull(projects.deletedAt),
        ),
      )
      .limit(wanted.length);

    if (rows.length !== wanted.length) return SAFE_INVOICE_LINE_DETAIL;

    return safestInvoiceLineDetail(rows.map((row) => row.invoiceLineDetail));
  }

  async markEntriesInvoiced(
    tx: TenantTx,
    orgId: string,
    entryIds: readonly number[],
  ): Promise<number> {
    const wanted = [...new Set(entryIds)];
    if (wanted.length === 0) return 0;

    const claimed = await tx
      .update(timesheets)
      .set({ invoicingStatus: "INVOICED", updatedAt: new Date() })
      .where(
        and(
          eq(timesheets.orgId, orgId),
          inArray(timesheets.id, wanted),
          ne(timesheets.invoicingStatus, "INVOICED"),
          eq(timesheets.status, "APPROVED"),
          isNull(timesheets.voidedAt),
        ),
      )
      .returning({ id: timesheets.id });

    return claimed.length;
  }

  /**
   * Reverses `markEntriesInvoiced` and the `createInvoiceDraft` export path:
   * puts entries stuck at `INVOICE_DRAFTED` or `INVOICED` back to
   * `UNINVOICED` so they are billable again.
   *
   * The two callers are (1) `InvoicesLifecycleService.voidInvoice`, once its
   * invoice is confirmed voided, for the entries `invoice_items` links to it,
   * and (2) releasing an `INVOICE_DRAFTED` snapshot that never became a real
   * invoice. Both are the fix for stranded `INVOICE_DRAFTED`/`INVOICED`
   * entries: entry lifecycle status (`status`, `voidedAt`) is untouched, so a
   * released entry lands back exactly where `listUninvoicedEntries` and
   * `getUninvoiced` already look for billable work — no separate "undo" read
   * path is needed.
   */
  async releaseEntriesToUninvoiced(
    tx: TenantTx,
    orgId: string,
    entryIds: readonly number[],
  ): Promise<number[]> {
    const wanted = [...new Set(entryIds)];
    if (wanted.length === 0) return [];

    const released = await tx
      .update(timesheets)
      .set({ invoicingStatus: "UNINVOICED", updatedAt: new Date() })
      .where(
        and(
          eq(timesheets.orgId, orgId),
          inArray(timesheets.id, wanted),
          ne(timesheets.invoicingStatus, "UNINVOICED"),
        ),
      )
      .returning({ id: timesheets.id });

    return released.map((row) => row.id);
  }
}
