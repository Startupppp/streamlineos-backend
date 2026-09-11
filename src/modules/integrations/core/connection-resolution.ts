import { and, desc, eq, ne, or, type SQL } from "drizzle-orm";
import {
  userIntegrationConnections,
  type IntegrationConnectionScope,
  type IntegrationConnectionStatus,
  type IntegrationToolkit,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { connectionOwnerPredicate } from "./connection-owner.predicate";

// A Composio principal, never a StreamlineOS user id: it keeps the shared account out of every
// `user_id = <member>` sweep and off the membership FK that cascades when its installer leaves.
export function orgComposioUserId(orgId: string): string {
  return `org:${orgId}`;
}

export type ResolvedIntegrationConnection = {
  connectionId: number;
  composioConnectedAccountId: string;
  composioUserId: string;
  scope: IntegrationConnectionScope;
  accountEmail: string | null;
};

export type IntegrationConnectionUnresolvedReason = "no-connection" | "needs-reauth";

export type IntegrationConnectionResolution =
  | { status: "resolved"; connection: ResolvedIntegrationConnection }
  | { status: "unresolved"; reason: IntegrationConnectionUnresolvedReason };

export type ToolkitConnectionSubject = {
  orgId: string;
  userId: string;
  membershipId?: number | null;
  toolkit: IntegrationToolkit;
};

type ResolutionCandidate = ResolvedIntegrationConnection & {
  status: IntegrationConnectionStatus;
};

const RESOLUTION_COLUMNS = {
  connectionId: userIntegrationConnections.id,
  composioConnectedAccountId: userIntegrationConnections.composioConnectedAccountId,
  composioUserId: userIntegrationConnections.userId,
  scope: userIntegrationConnections.scope,
  status: userIntegrationConnections.status,
  accountEmail: userIntegrationConnections.accountEmail,
} as const;

export function toolkitConnectionCandidatePredicate(
  subject: ToolkitConnectionSubject,
): SQL | undefined {
  return and(
    eq(userIntegrationConnections.orgId, subject.orgId),
    eq(userIntegrationConnections.toolkit, subject.toolkit),
    ne(userIntegrationConnections.status, "disabled"),
    or(
      connectionOwnerPredicate(subject.userId, subject.membershipId),
      eq(userIntegrationConnections.scope, "org"),
    ),
  );
}

function firstActiveOfScope(
  candidates: readonly ResolutionCandidate[],
  scope: IntegrationConnectionScope,
): ResolutionCandidate | undefined {
  return candidates.find((row) => row.scope === scope && row.status === "active");
}

function resolvedFrom(candidate: ResolutionCandidate): IntegrationConnectionResolution {
  return {
    status: "resolved",
    connection: {
      connectionId: candidate.connectionId,
      composioConnectedAccountId: candidate.composioConnectedAccountId,
      composioUserId: candidate.composioUserId,
      scope: candidate.scope,
      accountEmail: candidate.accountEmail,
    },
  };
}

export async function resolveToolkitConnection(
  db: Db,
  subject: ToolkitConnectionSubject,
): Promise<IntegrationConnectionResolution> {
  const candidates: ResolutionCandidate[] = await db
    .select(RESOLUTION_COLUMNS)
    .from(userIntegrationConnections)
    .where(toolkitConnectionCandidatePredicate(subject))
    .orderBy(
      desc(userIntegrationConnections.isPrimary),
      desc(userIntegrationConnections.createdAt),
    )
    .limit(20);

  const own = firstActiveOfScope(candidates, "user");
  if (own) return resolvedFrom(own);
  const shared = firstActiveOfScope(candidates, "org");
  if (shared) return resolvedFrom(shared);
  return {
    status: "unresolved",
    reason: candidates.length > 0 ? "needs-reauth" : "no-connection",
  };
}
