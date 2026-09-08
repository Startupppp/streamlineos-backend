import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  partyDuplicateCandidates,
  partyIdentifiers,
  partyRoles,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { assessDuplicate, type PartyFingerprint } from "./party-duplicates";
import {
  IDENTIFIER_KINDS,
  partiesSharingIdentifiers,
  type IdentifierClaim,
} from "./party-identifiers";
import { orderPair } from "./party-merge-plan";
import { PartyMergeService } from "./party-merge.service";
import { assertPartyInOrg } from "./party-tenant";

/** How many potential matches one detection pass will consider. */
const CANDIDATE_LIMIT = 25;

const IDENTIFIER_READ_LIMIT = (CANDIDATE_LIMIT + 1) * 32;

export interface DetectionResult {
  autoMerged: { survivorPartyId: string; mergedPartyId: string }[];
  queued: { candidateId: string; otherPartyId: string; score: number }[];
}

interface QueuedCandidate {
  readonly otherPartyId: string;
  readonly lowPartyId: string;
  readonly highPartyId: string;
  readonly score: number;
  readonly signals: string[];
  readonly blockers: string[];
}

@Injectable()
export class PartyRolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly merges: PartyMergeService,
  ) {}

  async listRoles(organizationId: string, partyId: string): Promise<string[]> {
    await assertPartyInOrg(this.db, organizationId, partyId);
    const rows = await this.db
      .select({ role: partyRoles.role })
      .from(partyRoles)
      .where(
        and(
          eq(partyRoles.organizationId, organizationId),
          eq(partyRoles.partyId, partyId),
          isNull(partyRoles.removedAt),
        ),
      );
    return rows.map((row) => row.role);
  }

  /**
   * Gives a party a role.
   *
   * Idempotent, and it never creates a record: a customer who starts supplying
   * you gains a role, and the alternative — a second party row for the same
   * business — is the duplication the merge machinery then has to undo.
   */
  async addRole(
    organizationId: string,
    partyId: string,
    role: string,
    userId: string,
  ): Promise<string[]> {
    await this.requireParty(organizationId, partyId);

    await this.db
      .insert(partyRoles)
      .values({ organizationId, partyId, role, assignedBy: userId })
      .onConflictDoUpdate({
        target: [partyRoles.organizationId, partyRoles.partyId, partyRoles.role],
        set: { removedAt: null, assignedBy: userId },
      });

    this.audit.log({
      action: "party.role.added",
      userId,
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: partyId,
      metadata: { role },
    });

    return this.listRoles(organizationId, partyId);
  }

  async removeRole(
    organizationId: string,
    partyId: string,
    role: string,
    userId: string,
  ): Promise<string[]> {
    await this.requireParty(organizationId, partyId);

    await this.db
      .delete(partyRoles)
      .where(
        and(
          eq(partyRoles.organizationId, organizationId),
          eq(partyRoles.partyId, partyId),
          eq(partyRoles.role, role),
        ),
      );

    this.audit.log({
      action: "party.role.removed",
      userId,
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: partyId,
      metadata: { role },
    });

    return this.listRoles(organizationId, partyId);
  }

  /**
   * Looks for other records describing the same organisation as this one.
   *
   * Candidates are drawn by exact match on an identifier, because those are the
   * only signals strong enough to merge on and the query stays indexed. A
   * name-similarity sweep would need a trigram index and a bounded scan; until
   * that exists, two records that share only a name are found by the human
   * looking at the list, not here.
   *
   * Through `party_identifiers` rather than through `business_parties.email`
   * and `.phone`: the columns compare as raw strings, so `Ops@Acme.example` and
   * `ops@acme.example` looked like different records, a number written with a
   * country code looked like a different line, and a customer known only on
   * WhatsApp had nothing to compare at all. The pairs most worth merging were
   * exactly the ones the column search could not see.
   */
  async detectFor(
    organizationId: string,
    partyId: string,
    userId: string,
  ): Promise<DetectionResult> {
    const subject = await this.requireParty(organizationId, partyId);
    const result: DetectionResult = { autoMerged: [], queued: [] };

    const candidateIds = await partiesSharingIdentifiers(
      this.db,
      organizationId,
      partyId,
      CANDIDATE_LIMIT,
    );

    if (candidateIds.length === 0) return result;

    const others = await this.db
      .select()
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          inArray(businessParties.partyId, candidateIds),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(CANDIDATE_LIMIT);

    const identifiers = await this.identifiersOfParties(organizationId, [
      partyId,
      ...others.map((other) => other.partyId),
    ]);

    const queued: QueuedCandidate[] = [];

    for (const other of others) {
      const assessment = assessDuplicate(
        toFingerprint(subject, identifiers.get(partyId) ?? []),
        toFingerprint(other, identifiers.get(other.partyId) ?? []),
      );

      if (assessment.verdict === "distinct") continue;

      if (assessment.verdict === "auto-merge") {
        const outcome = await this.merges.merge(organizationId, {
          leftPartyId: partyId,
          rightPartyId: other.partyId,
          decidedBy: "SYSTEM",
          userId,
        });
        result.autoMerged.push({
          survivorPartyId: outcome.survivorPartyId,
          mergedPartyId: outcome.mergedPartyId,
        });
        // The subject may have been the one merged away; stop rather than
        // continue comparing against a record that no longer exists.
        if (outcome.mergedPartyId === partyId) break;
        continue;
      }

      const { low, high } = orderPair(partyId, other.partyId);
      queued.push({
        otherPartyId: other.partyId,
        lowPartyId: low,
        highPartyId: high,
        score: assessment.score,
        signals: [...assessment.signals],
        blockers: [...assessment.blockers],
      });
    }

    if (queued.length === 0) return result;

    const written = await this.db
      .insert(partyDuplicateCandidates)
      .values(
        queued.map((entry) => ({
          organizationId,
          lowPartyId: entry.lowPartyId,
          highPartyId: entry.highPartyId,
          score: entry.score,
          signals: entry.signals,
          blockers: entry.blockers,
        })),
      )
      .onConflictDoUpdate({
        target: [
          partyDuplicateCandidates.organizationId,
          partyDuplicateCandidates.lowPartyId,
          partyDuplicateCandidates.highPartyId,
        ],
        set: { score: sql`excluded.score`, signals: sql`excluded.signals` },
      })
      .returning({
        candidateId: partyDuplicateCandidates.candidateId,
        lowPartyId: partyDuplicateCandidates.lowPartyId,
        highPartyId: partyDuplicateCandidates.highPartyId,
      });

    const candidateIdByPair = new Map(
      written.map((row): [string, string] => [
        `${row.lowPartyId}:${row.highPartyId}`,
        row.candidateId,
      ]),
    );

    for (const entry of queued) {
      const candidateId = candidateIdByPair.get(`${entry.lowPartyId}:${entry.highPartyId}`);
      if (candidateId)
        result.queued.push({
          candidateId,
          otherPartyId: entry.otherPartyId,
          score: entry.score,
        });
    }

    return result;
  }

  async listCandidates(organizationId: string, status = "PENDING") {
    return this.db
      .select()
      .from(partyDuplicateCandidates)
      .where(
        and(
          eq(partyDuplicateCandidates.organizationId, organizationId),
          eq(partyDuplicateCandidates.status, status),
        ),
      )
      .limit(100);
  }

  async dismissCandidate(
    organizationId: string,
    candidateId: string,
    userId: string,
  ): Promise<void> {
    const updated = await this.db
      .update(partyDuplicateCandidates)
      .set({ status: "DISMISSED", resolvedAt: new Date(), resolvedByUserId: userId })
      .where(
        and(
          eq(partyDuplicateCandidates.organizationId, organizationId),
          eq(partyDuplicateCandidates.candidateId, candidateId),
        ),
      )
      .returning({ candidateId: partyDuplicateCandidates.candidateId });

    if (updated.length === 0) throw new NotFoundException("Candidate not found");

    this.audit.log({
      action: "party.duplicate.dismissed",
      userId,
      orgId: organizationId,
      resourceType: "party_duplicate_candidate",
      resourceId: candidateId,
    });
  }

  private async identifiersOfParties(
    organizationId: string,
    partyIds: readonly string[],
  ): Promise<Map<string, IdentifierClaim[]>> {
    const grouped = new Map<string, IdentifierClaim[]>();
    const ids = [...new Set(partyIds)];
    if (ids.length === 0) return grouped;

    const rows = await this.db
      .select({
        partyId: partyIdentifiers.partyId,
        kind: partyIdentifiers.kind,
        value: partyIdentifiers.normalisedValue,
      })
      .from(partyIdentifiers)
      .where(
        and(
          eq(partyIdentifiers.organizationId, organizationId),
          inArray(partyIdentifiers.partyId, ids),
        ),
      )
      .limit(IDENTIFIER_READ_LIMIT);

    for (const row of rows) {
      if (!isKnownKind(row)) continue;
      const claims = grouped.get(row.partyId);
      if (claims) claims.push({ kind: row.kind, value: row.value });
      else grouped.set(row.partyId, [{ kind: row.kind, value: row.value }]);
    }
    return grouped;
  }

  private async requireParty(organizationId: string, partyId: string) {
    const [row] = await this.db
      .select()
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Party not found");
    return row;
  }
}

function isKnownKind(row: { kind: string; value: string }): row is IdentifierClaim {
  return IDENTIFIER_KINDS.some((kind) => kind === row.kind);
}

function toFingerprint(
  row: {
    partyId: string;
    name: string;
    legalName: string | null;
    email: string | null;
    phone: string | null;
    taxNumber: string | null;
    website: string | null;
  },
  identifiers: readonly { kind: string; value: string }[],
): PartyFingerprint {
  return {
    partyId: row.partyId,
    name: row.name,
    legalName: row.legalName,
    identifiers,
    // Still passed, and still only an input: a record whose columns were filled
    // in before 0260 and never touched since has the identifiers to prove it,
    // but one written by a path that has not yet been wired through
    // `claimIdentifiers` would otherwise compare as having no identity at all.
    email: row.email,
    phone: row.phone,
    taxNumber: row.taxNumber,
    website: row.website,
  };
}
