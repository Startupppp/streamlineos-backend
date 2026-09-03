import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties, partyDuplicateCandidates, partyRoles } from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { assessDuplicate, type PartyFingerprint } from "./party-duplicates";
import { identifiersOfParty, partiesSharingIdentifiers } from "./party-identifiers";
import { orderPair } from "./party-merge-plan";
import { PartyMergeService } from "./party-merge.service";
import { assertPartyInOrg } from "./party-tenant";

/** How many potential matches one detection pass will consider. */
const CANDIDATE_LIMIT = 25;

export interface DetectionResult {
  autoMerged: { survivorPartyId: string; mergedPartyId: string }[];
  queued: { candidateId: string; otherPartyId: string; score: number }[];
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

    const subjectIdentifiers = await identifiersOfParty(this.db, organizationId, partyId);

    for (const other of others) {
      const assessment = assessDuplicate(
        toFingerprint(subject, subjectIdentifiers),
        toFingerprint(other, await identifiersOfParty(this.db, organizationId, other.partyId)),
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
      const [candidate] = await this.db
        .insert(partyDuplicateCandidates)
        .values({
          organizationId,
          lowPartyId: low,
          highPartyId: high,
          score: assessment.score,
          signals: [...assessment.signals],
          blockers: [...assessment.blockers],
        })
        .onConflictDoUpdate({
          target: [
            partyDuplicateCandidates.organizationId,
            partyDuplicateCandidates.lowPartyId,
            partyDuplicateCandidates.highPartyId,
          ],
          set: { score: assessment.score, signals: [...assessment.signals] },
        })
        .returning({ candidateId: partyDuplicateCandidates.candidateId });

      if (candidate)
        result.queued.push({
          candidateId: candidate.candidateId,
          otherPartyId: other.partyId,
          score: assessment.score,
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
