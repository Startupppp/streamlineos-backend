import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheetExports,
  organizationMembers,
  organizationPeople,
} from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { resolveMapping } from "./lib/payroll-calc";
import { ackTransitionRefusal } from "./lib/ack-transition";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { payrollSnapshotSchema } from "./dto/payroll.schemas";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { TIMESHEET_EVENTS } from "./handoff/handoff.schemas";
import type {
  AckExportInput,
  ExportsListQuery,
  PayrollExportRow,
  TimesheetExportDto,
} from "./dto/payroll.schemas";

const exportFiltersSchema = z
  .object({ mapping: z.unknown().optional() })
  .passthrough();

function toExportDto(
  row: typeof timesheetExports.$inferSelect,
  creatorName: string | null,
): TimesheetExportDto {
  return {
    id: row.id,
    exportType: row.exportType,
    status: row.status,
    dateRangeStart: row.dateRangeStart,
    dateRangeEnd: row.dateRangeEnd,
    format: row.format,
    entryCount: row.entryCount,
    totalHours: parseFloat(row.totalHours),
    note: row.note,
    ackStatus: row.ackStatus,
    ackAt: row.ackAt ? row.ackAt.toISOString() : null,
    createdBy: null,
    createdByName: creatorName,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class PayrollExportsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listExports(orgId: string, query: ExportsListQuery) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.payrollExportsNamespace(orgId),
      `${query.cursor ?? ""}:${query.limit}`,
      async () => {
        const limit = Math.min(query.limit, 100);
        const pos = decodeCursor(query.cursor);
        const conditions = [eq(timesheetExports.orgId, orgId)];
        if (pos)
          conditions.push(
            keysetBeforeId(
              timesheetExports.createdAt,
              timesheetExports.id,
              pos,
            ),
          );

        const rawRows = await this.db
          .select({
            export: timesheetExports,
            creatorName: organizationPeople.displayName,
          })
          .from(timesheetExports)
          .leftJoin(
            organizationPeople,
            and(
              eq(organizationPeople.organizationId, timesheetExports.orgId),
              eq(
                organizationPeople.organizationMembershipId,
                timesheetExports.createdByMembershipId,
              ),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(timesheetExports.createdAt), desc(timesheetExports.id))
          .limit(limit + 1);

        const dtos = rawRows.map(({ export: exp, creatorName }) =>
          toExportDto(exp, creatorName ?? null),
        );

        return buildCursorPage(dtos, limit, (dto) => ({
          sortValue: dto.createdAt,
          id: String(dto.id),
        }));
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getExportRows(orgId: string, exportId: number) {
    const [result] = await this.db
      .select({
        export: timesheetExports,
        creatorName: organizationPeople.displayName,
      })
      .from(timesheetExports)
      .leftJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, timesheetExports.orgId),
          eq(
            organizationPeople.organizationMembershipId,
            timesheetExports.createdByMembershipId,
          ),
        ),
      )
      .where(
        and(
          eq(timesheetExports.id, exportId),
          eq(timesheetExports.orgId, orgId),
        ),
      )
      .limit(1);

    if (!result) throw new NotFoundException("Export not found");

    const parsedSnapshot = payrollSnapshotSchema.safeParse(
      result.export.snapshot,
    );
    const rows: PayrollExportRow[] = parsedSnapshot.success
      ? parsedSnapshot.data
      : [];

    const parsedFilters = exportFiltersSchema.safeParse(
      result.export.filters ?? {},
    );
    const mappingRaw = parsedFilters.success
      ? parsedFilters.data.mapping
      : undefined;
    const mapping =
      mappingRaw === undefined || mappingRaw === null
        ? null
        : resolveMapping(mappingRaw);

    return {
      export: toExportDto(result.export, result.creatorName ?? null),
      rows,
      mapping,
    };
  }

  async ackExport(orgId: string, userId: string, exportId: number, input: AckExportInput) {
    const [existing] = await this.db
      .select({
        id: timesheetExports.id,
        ackStatus: timesheetExports.ackStatus,
        creatorName: organizationPeople.displayName,
      })
      .from(timesheetExports)
      .leftJoin(organizationPeople, and(
        eq(organizationPeople.organizationId, timesheetExports.orgId),
        eq(organizationPeople.organizationMembershipId, timesheetExports.createdByMembershipId),
      ))
      .where(and(eq(timesheetExports.id, exportId), eq(timesheetExports.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Export not found");

    const refusal = ackTransitionRefusal(existing.ackStatus, input.status);
    if (refusal) throw new ConflictException(refusal);

    const [ackActorMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);

    const ackAt = new Date();
    const updated = await this.db.transaction(async (tx) => {
      /**
       * Conditional on the status that was checked above, so two operators
       * acknowledging at once cannot both pass the transition rule against
       * the same stale reading: the second UPDATE matches nothing and is told
       * so, rather than overwriting the first and emitting a second event.
       */
      const [row] = await tx
        .update(timesheetExports)
        .set({
          ackStatus: input.status,
          ackNote: input.note ?? null,
          ackAt,
          ackByMembershipId: ackActorMember?.id ?? null,
          eventSeq: sql`${timesheetExports.eventSeq} + 1`,
        })
        .where(
          and(
            eq(timesheetExports.id, exportId),
            eq(timesheetExports.orgId, orgId),
            existing.ackStatus === null
              ? isNull(timesheetExports.ackStatus)
              : eq(timesheetExports.ackStatus, existing.ackStatus),
          ),
        )
        .returning();

      if (!row) return null;

      /**
       * In the same transaction as the status it reports, so an
       * acknowledgement cannot be recorded without its event or announced
       * without being recorded.
       */
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "timesheet_export",
        aggregateId: String(exportId),
        /**
         * The counter the UPDATE just claimed. Version 1 is the export's own
         * creation event, and an export is acknowledged repeatedly as its
         * status moves, so each one takes the next number — see
         * `timesheetExports.eventSeq`.
         */
        aggregateVersion: row.eventSeq,
        eventType: TIMESHEET_EVENTS.payrollExportAcked,
        payload: {
          organization_id: orgId,
          export_id: exportId,
          status: input.status,
          note: input.note ?? null,
          acked_at: ackAt.toISOString(),
          actor_user_id: userId,
        },
        occurredAt: ackAt,
      });

      return row;
    });

    if (!updated) throw new ConflictException("Export was acknowledged by someone else; reload and try again");

    this.audit.log({ action: "timesheets.payroll.export_acknowledged", userId, orgId, metadata: { exportId, status: input.status, note: input.note ?? null } });

    await this.cache.invalidateNamespace(CACHE_KEYS.payrollExportsNamespace(orgId));

    return { export: toExportDto(updated, existing.creatorName ?? null) };
  }
}
