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
import type { ScopedRead } from "../../access/scoped-read";
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

  private static readonly NOBODYS_OWN_ROW = { own: sql`false` } as const;

  async listExports(read: ScopedRead, query: ExportsListQuery) {
    const orgId = read.orgId;
    return this.cache.cachedVersioned(
      CACHE_KEYS.payrollExportsNamespace(orgId),
      `${read.discriminator}:${query.cursor ?? ""}:${query.limit}`,
      async () => {
        const limit = Math.min(query.limit, 100);
        const pos = decodeCursor(query.cursor);
        const empty = () => buildCursorPage<TimesheetExportDto>([], limit, (dto) => ({ sortValue: dto.createdAt, id: String(dto.id) }));

        return read.read(
          {
            tenant: timesheetExports.orgId,
            scope: PayrollExportsReadService.NOBODYS_OWN_ROW,
            and: [pos ? keysetBeforeId(timesheetExports.createdAt, timesheetExports.id, pos) : undefined],
          },
          async ({ sql: where }) => {
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
              .where(where)
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
          empty,
        );
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getExportRows(read: ScopedRead, exportId: number) {
    const [result] = await read.read(
      {
        tenant: timesheetExports.orgId,
        scope: PayrollExportsReadService.NOBODYS_OWN_ROW,
        and: [eq(timesheetExports.id, exportId)],
      },
      ({ sql: where }) =>
        this.db
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
          .where(where)
          .limit(1),
      () => [],
    );

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

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "timesheet_export",
        aggregateId: String(exportId),
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
