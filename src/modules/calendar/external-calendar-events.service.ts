import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { calendarEvents, userIntegrationConnections } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { ComposioGateway, ComposioToolError } from "../integrations/composio.gateway";
import {
  TOOL_SLUGS,
  normalizeGoogleEvents,
  normalizeOutlookEvents,
  type ExternalCalendarEventItem,
} from "./external-event-normalizers";

export interface ExternalEventsResult {
  events: ExternalCalendarEventItem[];
  errors: Array<{ connectionId: number; accountEmail: string | null; message: string }>;
}

@Injectable()
export class ExternalCalendarEventsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly gateway: ComposioGateway,
  ) {}

  async getExternalEvents(
    orgId: string,
    userId: string,
    startIso: string,
    endIso: string,
  ): Promise<ExternalEventsResult> {
    if (!this.gateway.isConfigured()) return { events: [], errors: [] };
    const connections = await this.db
      .select({
        id: userIntegrationConnections.id,
        toolkit: userIntegrationConnections.toolkit,
        accountEmail: userIntegrationConnections.accountEmail,
        composioConnectedAccountId: userIntegrationConnections.composioConnectedAccountId,
      })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.orgId, orgId),
          eq(userIntegrationConnections.userId, userId),
          eq(userIntegrationConnections.status, "active"),
        ),
      );
    if (connections.length === 0) return { events: [], errors: [] };

    const mappedRows = await this.db
      .select({ externalEventId: calendarEvents.externalEventId })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          inArray(
            calendarEvents.integrationConnectionId,
            connections.map((c) => c.id),
          ),
          isNotNull(calendarEvents.externalEventId),
        ),
      );
    const mapped = new Set(mappedRows.map((r) => r.externalEventId));

    const settled = await Promise.allSettled(
      connections.map((conn) => this.fetchForConnection(userId, conn, startIso, endIso)),
    );

    const events: ExternalCalendarEventItem[] = [];
    const errors: ExternalEventsResult["errors"] = [];
    settled.forEach((outcome, i) => {
      const conn = connections[i];
      if (!conn) return;
      if (outcome.status === "fulfilled") {
        events.push(...outcome.value.filter((e) => !mapped.has(e.providerEventId)));
      } else {
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : "Failed to load external events";
        errors.push({ connectionId: conn.id, accountEmail: conn.accountEmail, message });
        if (outcome.reason instanceof ComposioToolError && outcome.reason.isAuthError) {
          void this.db
            .update(userIntegrationConnections)
            .set({ status: "needs_reauth" })
            .where(eq(userIntegrationConnections.id, conn.id));
        }
      }
    });
    events.sort((a, b) => a.start.localeCompare(b.start));
    return { events, errors };
  }

  private fetchForConnection(
    userId: string,
    conn: {
      id: number;
      toolkit: "googlecalendar" | "outlook";
      accountEmail: string | null;
      composioConnectedAccountId: string;
    },
    startIso: string,
    endIso: string,
  ): Promise<ExternalCalendarEventItem[]> {
    const cacheKey = `integrations:extevents:${conn.id}:${startIso}:${endIso}`;
    return this.cache.cached(
      cacheKey,
      async () => {
        if (conn.toolkit === "googlecalendar") {
          const data = await this.gateway.executeTool(
            TOOL_SLUGS.googleList,
            userId,
            { timeMin: startIso, timeMax: endIso, maxResults: 100, singleEvents: true },
            conn.composioConnectedAccountId,
          );
          return normalizeGoogleEvents(data, conn);
        }
        const data = await this.gateway.executeTool(
          TOOL_SLUGS.outlookList,
          userId,
          { startDateTime: startIso, endDateTime: endIso, top: 100 },
          conn.composioConnectedAccountId,
        );
        return normalizeOutlookEvents(data, conn);
      },
      60,
    );
  }
}
