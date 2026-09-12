import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { aliasedTable, and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  partyContacts,
  partyDuplicateCandidates,
  partyMerges,
  partyRoles,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { assessDuplicate, type PartyFingerprint } from "./party-duplicates";
import {
  identifiersOfParty,
  moveIdentifiers,
  type IdentifierClaim,
} from "./party-identifiers-merge";
import { chooseSurvivor, orderPair, planMerge, type FieldConflict, type MergeableField } from "./party-merge-plan";
import { refreshEmployerColumns, repointEmployerParties } from "./party-legacy-employer";
import {
  refreshPartyMirrors,
  softDeletePartyWithMirror,
  updatePartyWithMirror,
} from "./party-legacy-writer";
import { legacyIdsOf, repointLegacyIds } from "./party-merge-legacy-ids";
import type { MergeSnapshot } from "./dto/party-merge-snapshot.schema";
import type { PartyRow } from "./party-mirror-fields";

export interface MergeOutcome {
  partyMergeId: string;
  survivorPartyId: string;
  mergedPartyId: string;
  conflicts: Partial<Record<MergeableField, FieldConflict>>;
}

@Injectable()
export class PartyMergeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async load(organizationId: string, partyId: string) {
    const [row] = await this.db
      .select()
      .from(businessParties)
      .where(
        and(
          eq(businessParties.partyId, partyId),
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);
    return row;
  }

  private static fingerprint(
    row: PartyRow,
    identifiers: readonly IdentifierClaim[],
  ): PartyFingerprint {
    return {
      partyId: row.partyId,
      name: row.name,
      legalName: row.legalName,
      identifiers,
      email: row.email,
      phone: row.phone,
      taxNumber: row.taxNumber,
      website: row.website,
    };
  }

  private async rolesOf(organizationId: string, partyId: string): Promise<string[]> {
    const rows = await this.db
      .select({ role: partyRoles.role })
      .from(partyRoles)
      .where(and(eq(partyRoles.organizationId, organizationId), eq(partyRoles.partyId, partyId)));
    return rows.map((row) => row.role);
  }

  private async closeCandidate(
    organizationId: string,
    a: string,
    b: string,
    status: "MERGED" | "DISMISSED",
    userId?: string,
  ): Promise<void> {
    const { low, high } = orderPair(a, b);
    await this.db
      .update(partyDuplicateCandidates)
      .set({ status, resolvedAt: new Date(), resolvedByUserId: userId ?? null })
      .where(
        and(
          eq(partyDuplicateCandidates.organizationId, organizationId),
          eq(partyDuplicateCandidates.lowPartyId, low),
          eq(partyDuplicateCandidates.highPartyId, high),
        ),
      );
  }

  async merge(
    organizationId: string,
    input: {
      leftPartyId: string;
      rightPartyId: string;
      decidedBy: "SYSTEM" | "USER";
      userId?: string;
      preferSurvivorPartyId?: string;
    },
  ): Promise<MergeOutcome> {
    if (input.leftPartyId === input.rightPartyId)
      throw new BadRequestException("Cannot merge a party with itself");

    const [left, right] = await Promise.all([
      this.load(organizationId, input.leftPartyId),
      this.load(organizationId, input.rightPartyId),
    ]);

    if (!left || !right) throw new NotFoundException("Party not found");

    const preferred = input.preferSurvivorPartyId;
    if (preferred && preferred !== left.partyId && preferred !== right.partyId)
      throw new BadRequestException("preferSurvivorPartyId must name one of the two parties");

    const { survivor: survivorId, merged: mergedId } = preferred
      ? {
          survivor: preferred,
          merged: preferred === left.partyId ? right.partyId : left.partyId,
        }
      : chooseSurvivor(
          { partyId: left.partyId, createdAt: left.createdAt },
          { partyId: right.partyId, createdAt: right.createdAt },
        );
    const survivor = survivorId === left.partyId ? left : right;
    const loser = survivorId === left.partyId ? right : left;

    const plan = planMerge(survivor, loser);

    const [survivorRoles, loserRoles, loserContacts] = await Promise.all([
      this.rolesOf(organizationId, survivorId),
      this.rolesOf(organizationId, mergedId),
      this.db
        .select({ partyContactId: partyContacts.partyContactId })
        .from(partyContacts)
        .where(
          and(
            eq(partyContacts.organizationId, organizationId),
            eq(partyContacts.partyId, mergedId),
            isNull(partyContacts.deletedAt),
          ),
        ),
    ]);

    const addedRoles = loserRoles.filter((role) => !survivorRoles.includes(role));
    const movedContactIds = loserContacts.map((contact) => contact.partyContactId);
    const movedLegacyIds = await legacyIdsOf(this.db, organizationId, mergedId);

    const movedEmployeePartyIds = await repointEmployerParties(
      this.db,
      organizationId,
      mergedId,
      survivorId,
    );

    const [survivorIdentifiers, loserIdentifiers] = await Promise.all([
      identifiersOfParty(this.db, organizationId, survivorId),
      identifiersOfParty(this.db, organizationId, mergedId),
    ]);

    const assessment = assessDuplicate(
      PartyMergeService.fingerprint(survivor, survivorIdentifiers),
      PartyMergeService.fingerprint(loser, loserIdentifiers),
    );

    const movedIdentifierIds = await moveIdentifiers(
      this.db,
      organizationId,
      mergedId,
      survivorId,
    );

    const snapshot: MergeSnapshot = {
      survivorBefore: { ...survivor },
      mergedBefore: { ...loser },
      movedContactIds,
      addedRoles,
      movedLegacyIds,
      movedIdentifierIds,
      movedEmployeePartyIds,
    };

    if (Object.keys(plan.survivorPatch).length > 0 || plan.customFields)
      await updatePartyWithMirror(this.db, organizationId, survivorId, {
        ...plan.survivorPatch,
        customFields: plan.customFields,
      });

    if (movedContactIds.length > 0)
      await this.db
        .update(partyContacts)
        .set({ partyId: survivorId })
        .where(
          and(
            eq(partyContacts.organizationId, organizationId),
            inArray(partyContacts.partyContactId, movedContactIds),
          ),
        );

    await repointLegacyIds(this.db, organizationId, movedLegacyIds, survivorId);

    await refreshPartyMirrors(this.db, organizationId, survivorId);

    await refreshEmployerColumns(this.db, organizationId, movedEmployeePartyIds);

    if (addedRoles.length > 0)
      await this.db
        .insert(partyRoles)
        .values(
          addedRoles.map((role) => ({ organizationId, partyId: survivorId, role })),
        )
        .onConflictDoNothing();

    await softDeletePartyWithMirror(this.db, organizationId, mergedId);

    const [record] = await this.db
      .insert(partyMerges)
      .values({
        organizationId,
        survivorPartyId: survivorId,
        mergedPartyId: mergedId,
        decidedBy: input.decidedBy,
        decidedByUserId: input.userId ?? null,
        confidence: assessment.score,
        signals: [...assessment.signals],
        conflicts: plan.conflicts,
        snapshot,
      })
      .returning({ partyMergeId: partyMerges.partyMergeId });

    await this.closeCandidate(organizationId, survivorId, mergedId, "MERGED", input.userId);

    // logCritical, not log: a merge is destructive and performed unattended, so
    // an audit write that fails must stop it rather than leave it unrecorded.
    // Which is exactly why the unattended case needs a null actor: it used to
    // write the string "system", which has no row in `users`, so the merges
    // this line is protecting were the ones it aborted.
    const mergeAudit = {
      action: "party.merge",
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: survivorId,
      before: snapshot,
      metadata: {
        mergedPartyId: mergedId,
        decidedBy: input.decidedBy,
        confidence: assessment.score,
        signals: assessment.signals,
        conflicts: Object.keys(plan.conflicts),
      },
    };

    await this.audit.logCritical(
      input.userId
        ? { ...mergeAudit, userId: input.userId }
        : { ...mergeAudit, systemActor: "party.merge.unattended" },
    );

    return {
      partyMergeId: record?.partyMergeId ?? "",
      survivorPartyId: survivorId,
      mergedPartyId: mergedId,
      conflicts: plan.conflicts,
    };
  }

  /**
   * The merges this organisation has performed, most recent first.
   *
   * `party_merges` already held everything a revert needs, and nothing read it —
   * so the only moment a merge could be undone was the moment it happened, from
   * whatever the caller still had in hand. A destructive operation whose reversal
   * expires with the toast that announced it is not reversible in any sense the
   * user experiences, which is the whole reason the snapshot is taken.
   *
   * The survivor is joined in for its name; the loser is not, because it is
   * soft-deleted and every party read in this module filters that out. Its name
   * comes from the snapshot instead, which is the record of what it was called
   * at the moment it stopped existing — the right answer here even if a later
   * revert-and-rename made the live row disagree.
   */
  async listMerges(
    organizationId: string,
    query: { page: number; limit: number; includeReverted: boolean },
  ) {
    const survivor = aliasedTable(businessParties, "survivor_party");

    const where = and(
      eq(partyMerges.organizationId, organizationId),
      query.includeReverted ? undefined : isNull(partyMerges.revertedAt),
      eq(survivor.organizationId, organizationId),
    );

    const [rows, totals] = await Promise.all([
      this.db
        .select({
          partyMergeId: partyMerges.partyMergeId,
          survivorPartyId: partyMerges.survivorPartyId,
          survivorName: survivor.name,
          mergedPartyId: partyMerges.mergedPartyId,
          snapshot: partyMerges.snapshot,
          decidedBy: partyMerges.decidedBy,
          decidedByUserId: partyMerges.decidedByUserId,
          confidence: partyMerges.confidence,
          conflicts: partyMerges.conflicts,
          mergedAt: partyMerges.mergedAt,
          revertedAt: partyMerges.revertedAt,
        })
        .from(partyMerges)
        .innerJoin(survivor, eq(survivor.partyId, partyMerges.survivorPartyId))
        .where(where)
        .orderBy(desc(partyMerges.mergedAt), desc(partyMerges.partyMergeId))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db
        .select({ total: count() })
        .from(partyMerges)
        .innerJoin(survivor, eq(survivor.partyId, partyMerges.survivorPartyId))
        .where(where),
    ]);

    return {
      data: rows.map((row) => {
        const snapshot = row.snapshot as unknown as MergeSnapshot | null;
        return {
          partyMergeId: row.partyMergeId,
          survivorPartyId: row.survivorPartyId,
          survivorName: row.survivorName,
          mergedPartyId: row.mergedPartyId,
          mergedName: String(snapshot?.mergedBefore?.name ?? ""),
          decidedBy: row.decidedBy,
          decidedByUserId: row.decidedByUserId,
          confidence: row.confidence,
          // The keys only: the discarded values are evidence for an audit
          // reader, not something a list should put on screen.
          conflictFields: Object.keys(row.conflicts ?? {}),
          mergedAt: row.mergedAt,
          revertedAt: row.revertedAt,
        };
      }),
      pagination: { page: query.page, limit: query.limit, total: totals[0]?.total ?? 0 },
    };
  }
}
