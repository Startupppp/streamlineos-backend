import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { crmConnectorSyncs, userIntegrationConnections } from "../../../db/schema";
import { streamFor } from "./connectors/connector-catalog";
import {
  isConnectorProvider,
  isConnectorStream,
  type ConnectorRequest,
  type ConnectorStreamDescriptor,
} from "./connectors/connector-source";

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

/**
 * The stream descriptor a sync row names, validated rather than trusted.
 *
 * `provider` and `stream` are stored as plain text — no enum, no CHECK — so a
 * row from an older release or a manual edit can name a pair the catalog no
 * longer has. Narrowing with the same guards `isConnectorProvider` uses is a
 * real check, not a cast that just hopes the column still agrees with the code.
 */
export function descriptorForSync(sync: {
  readonly crmConnectorSyncId: string;
  readonly provider: string;
  readonly stream: string;
}): ConnectorStreamDescriptor {
  if (!isConnectorProvider(sync.provider) || !isConnectorStream(sync.stream))
    throw new Error(
      `Connector sync ${sync.crmConnectorSyncId} names an unrecognised provider/stream: ${sync.provider}/${sync.stream}`,
    );
  return streamFor(sync.provider, sync.stream);
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
