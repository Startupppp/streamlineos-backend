import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { outboxEvents } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../tenant";
import type { OutboxMetrics, OutboxOrganizationReport, OutboxReport } from "./outbox-publisher.types";

@Injectable()
export class OutboxReportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async metrics(): Promise<OutboxMetrics> {
    const result: OutboxMetrics = { pending: 0, inFlight: 0, dead: 0, oldestPendingAt: null };
    await forEachOrg(this.db, "outbox-events-metrics", async (tx) => {
      const rows = await tx
        .select({
          totalRows: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          inFlight: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'IN_FLIGHT')`,
          dead: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'DEAD')`,
          oldestPendingAt: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          oldestEventAt: sql<Date | null>`min(${outboxEvents.createdAt})`,
        })
        .from(outboxEvents);
      const row = rows[0];
      if (!row) return;
      result.pending += Number(row.pending ?? 0);
      result.inFlight += Number(row.inFlight ?? 0);
      result.dead += Number(row.dead ?? 0);
      if (row.oldestPendingAt && (!result.oldestPendingAt || row.oldestPendingAt < result.oldestPendingAt)) {
        result.oldestPendingAt = row.oldestPendingAt;
      }
    });
    return result;
  }

  async reportByOrganization(): Promise<OutboxOrganizationReport[]> {
    const reports: OutboxOrganizationReport[] = [];
    await forEachOrg(this.db, "outbox-events-report", async (tx, organizationId) => {
      const rows = await tx
        .select({
          totalRows: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          inFlight: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'IN_FLIGHT')`,
          dead: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'DEAD')`,
          oldestPendingAt: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          oldestEventAt: sql<Date | null>`min(${outboxEvents.createdAt})`,
          distinctEventTypes: sql<number>`count(distinct ${outboxEvents.eventType})`,
        })
        .from(outboxEvents);
      const row = rows[0];
      reports.push({
        organizationId,
        totalRows: Number(row?.totalRows ?? 0),
        pending: Number(row?.pending ?? 0),
        inFlight: Number(row?.inFlight ?? 0),
        dead: Number(row?.dead ?? 0),
        oldestPendingAt: row?.oldestPendingAt ?? null,
        oldestEventAt: row?.oldestEventAt ?? null,
        oldestEventAgeSeconds: row?.oldestEventAt
          ? Math.max(0, Math.floor((Date.now() - new Date(row.oldestEventAt).getTime()) / 1000))
          : null,
        distinctEventTypes: Number(row?.distinctEventTypes ?? 0),
      });
    });
    return reports;
  }

  async report(): Promise<OutboxReport> {
    const reports: OutboxOrganizationReport[] = [];
    const result = await forEachOrg(this.db, "outbox-events-report", async (tx, organizationId) => {
      const rows = await tx
        .select({
          totalRows: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          inFlight: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'IN_FLIGHT')`,
          dead: sql<number>`count(*) filter (where ${outboxEvents.deliveryState} = 'DEAD')`,
          oldestPendingAt: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.deliveryState} = 'PENDING')`,
          oldestEventAt: sql<Date | null>`min(${outboxEvents.createdAt})`,
          distinctEventTypes: sql<number>`count(distinct ${outboxEvents.eventType})`,
        })
        .from(outboxEvents);
      const row = rows[0];
      reports.push({
        organizationId,
        totalRows: Number(row?.totalRows ?? 0),
        pending: Number(row?.pending ?? 0),
        inFlight: Number(row?.inFlight ?? 0),
        dead: Number(row?.dead ?? 0),
        oldestPendingAt: row?.oldestPendingAt ?? null,
        oldestEventAt: row?.oldestEventAt ?? null,
        oldestEventAgeSeconds: row?.oldestEventAt
          ? Math.max(0, Math.floor((Date.now() - new Date(row.oldestEventAt).getTime()) / 1000))
          : null,
        distinctEventTypes: Number(row?.distinctEventTypes ?? 0),
      });
    });
    return {
      generatedAt: new Date().toISOString(),
      organizations: result.organizations,
      succeeded: result.succeeded,
      failed: result.failed,
      reports,
    };
  }
}
