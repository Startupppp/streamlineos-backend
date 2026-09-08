import type { Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { dataQualityFindings } from "../../db/schema";
import { PartyMergeService } from "../party/party-merge.service";
import { refuseIfContradicted } from "./merge-guard";
import { withSavepoint } from "./savepoint";
import { reopenFailedFinding, type ClaimedFinding } from "./data-quality-finding-claim";

export interface ExecutionFailure {
  findingId: string;
  error: string;
}

export interface RemediationDeps {
  readonly db: Db;
  readonly merges: PartyMergeService;
  readonly logger: Logger;
}

export async function applyAll(
  deps: RemediationDeps,
  organizationId: string,
  userId: string,
  claimed: readonly ClaimedFinding[],
): Promise<ExecutionFailure[]> {
  const failures: ExecutionFailure[] = [];
  const undoTokens: Record<string, Record<string, unknown>> = {};

  for (const finding of claimed) {
    if (finding.proposedAction === "none") continue;

    try {
      undoTokens[finding.findingId] = await withSavepoint(() =>
        execute(deps, organizationId, userId, finding),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ findingId: finding.findingId, error: message });
      deps.logger.warn(`finding ${finding.findingId} could not be applied: ${message}`);
      await reopenFailedFinding(deps.db, organizationId, finding.findingId, message);
    }
  }

  await recordUndoTokens(deps.db, organizationId, undoTokens);

  return failures;
}

async function recordUndoTokens(
  db: Db,
  organizationId: string,
  undoTokens: Record<string, Record<string, unknown>>,
): Promise<void> {
  const findingIds = Object.keys(undoTokens);
  if (findingIds.length === 0) return;

  await db
    .update(dataQualityFindings)
    .set({
      undoToken: sql`${JSON.stringify(undoTokens)}::jsonb -> ${dataQualityFindings.findingId}`,
    })
    .where(
      and(
        eq(dataQualityFindings.organizationId, organizationId),
        inArray(dataQualityFindings.findingId, findingIds),
      ),
    );
}

async function execute(
  deps: RemediationDeps,
  organizationId: string,
  userId: string,
  finding: ClaimedFinding,
): Promise<Record<string, unknown>> {
  if (finding.proposedAction !== "merge-parties")
    throw new Error(`No executor for ${finding.proposedAction}`);

  if (!finding.relatedPartyId)
    throw new Error("A merge needs two parties and this finding names one");

  await refuseIfContradicted(deps.db, organizationId, finding.partyId, finding.relatedPartyId);

  const outcome = await deps.merges.merge(organizationId, {
    leftPartyId: finding.partyId,
    rightPartyId: finding.relatedPartyId,
    decidedBy: "USER",
    userId,
  });

  return {
    partyMergeId: outcome.partyMergeId,
    survivorPartyId: outcome.survivorPartyId,
    mergedPartyId: outcome.mergedPartyId,
  };
}
