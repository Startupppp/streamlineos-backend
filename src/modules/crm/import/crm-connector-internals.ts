import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { crmConnectorSyncs, userIntegrationConnections } from "../../../db/schema";
import type { ConnectorRequest } from "./connectors/connector-source";

export type WalkExtent = {
  readonly settled: boolean;
  readonly reason: string | null;
  readonly startAt: ConnectorRequest | null;
  readonly since: string | null;
};

export type PageOutcome = {
  readonly staged: number;
  readonly total: number;
  readonly next: ConnectorRequest | null;
};

export type WalkResult = {
  readonly crmImportId: string | null;
  readonly records: number;
  readonly drained: boolean;
  readonly watermarkAdvanced: boolean;
};

export const MAX_PAGES_PER_WALK = 25;

export const FAILURE_LIMIT = 10;

export function settled(reason: string): WalkExtent {
  return { settled: true, reason, startAt: null, since: null };
}

export async function getSync(
  db: Db,
  organizationId: string,
  crmConnectorSyncId: string,
) {
  const [row] = await db
    .select()
    .from(crmConnectorSyncs)
    .where(
      and(
        eq(crmConnectorSyncs.organizationId, organizationId),
        eq(crmConnectorSyncs.crmConnectorSyncId, crmConnectorSyncId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function getConnection(
  db: Db,
  organizationId: string,
  connectionId: number,
) {
  const [row] = await db
    .select({
      userId: userIntegrationConnections.userId,
      toolkit: userIntegrationConnections.toolkit,
      composioAccountId: userIntegrationConnections.composioConnectedAccountId,
      status: userIntegrationConnections.status,
    })
    .from(userIntegrationConnections)
    .where(
      and(
        eq(userIntegrationConnections.orgId, organizationId),
        eq(userIntegrationConnections.id, connectionId),
      ),
    )
    .limit(1);

  return row ?? null;
}
