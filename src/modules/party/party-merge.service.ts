import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  leadPartyMap,
  partyContacts,
  partyDuplicateCandidates,
  partyMerges,
  partyRoles,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { assessDuplicate, type PartyFingerprint } from "./party-duplicates";
import { chooseSurvivor, orderPair, planMerge } from "./party-merge-plan";
import {
  refreshPartyMirrors,
  restorePartyWithMirror,
  softDeletePartyWithMirror,
  updatePartyWithMirror,
} from "./party-legacy-writer";

interface MergeSnapshot {
  survivorBefore: Record<string, unknown>;
  mergedBefore: Record<string, unknown>;
  movedContactIds: string[];
  addedRoles: string[];
  /**
   * Legacy identifiers re-pointed onto the survivor, per kind.
   *
   * Optional because merges recorded before the expand step have no such
   * identifiers, and a revert must still be able to read those snapshots.
   */
  movedLegacyIds?: LegacyIdsByKind;
}

interface LegacyIdsByKind {
  lead: number[];
  client: number[];
  contact: number[];
}

const NO_LEGACY_IDS: LegacyIdsByKind = { lead: [], client: [], contact: [] };

export interface MergeOutcome {
  partyMergeId: string;
  survivorPartyId: string;
  mergedPartyId: string;
  conflicts: Record<string, { kept: unknown; discarded: unknown }>;
}

/**
 * Merging two party records, and putting them back.
 *
 * Every merge captures both rows verbatim first. That is not defensive
 * bookkeeping — the system performs some of these without asking anyone, and an
 * automatic destructive operation that cannot be undone is not one worth having.
 */
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

  private static fingerprint(row: Record<string, unknown>): PartyFingerprint {
    return {
      partyId: String(row.partyId),
      name: String(row.name ?? ""),
      legalName: (row.legalName ?? null) as string | null,
      email: (row.email ?? null) as string | null,
      phone: (row.phone ?? null) as string | null,
      taxNumber: (row.taxNumber ?? null) as string | null,
      website: (row.website ?? null) as string | null,
    };
  }

  /**
   * Merges two records into one.
   *
   * `decidedBy` distinguishes a merge the detector was confident enough to make
   * on its own from one a human confirmed, because the two deserve different
   * scrutiny when someone reviews what happened.
   */
  async merge(
    organizationId: string,
    input: {
      leftPartyId: string;
      rightPartyId: string;
      decidedBy: "SYSTEM" | "USER";
      userId?: string;
    },
  ): Promise<MergeOutcome> {
    if (input.leftPartyId === input.rightPartyId)
      throw new BadRequestException("Cannot merge a party with itself");

    const [left, right] = await Promise.all([
      this.load(organizationId, input.leftPartyId),
      this.load(organizationId, input.rightPartyId),
    ]);

    // Not-found rather than forbidden: a record in another tenant must read as
    // absent, or the response confirms it exists.
    if (!left || !right) throw new NotFoundException("Party not found");

    const { survivor: survivorId, merged: mergedId } = chooseSurvivor(
      { partyId: left.partyId, createdAt: left.createdAt },
      { partyId: right.partyId, createdAt: right.createdAt },
    );
    const survivor = survivorId === left.partyId ? left : right;
    const loser = survivorId === left.partyId ? right : left;

    const assessment = assessDuplicate(
      PartyMergeService.fingerprint(survivor),
      PartyMergeService.fingerprint(loser),
    );
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
    const movedLegacyIds = await this.legacyIdsOf(organizationId, mergedId);

    const snapshot: MergeSnapshot = {
      survivorBefore: { ...survivor },
      mergedBefore: { ...loser },
      movedContactIds,
      addedRoles,
      movedLegacyIds,
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

    // The lead, client and contact ids the loser answered for now answer for the
    // survivor. Re-pointing them here, rather than teaching the resolver to walk
    // the merge ledger, is what keeps one merge mechanism instead of two -- and
    // it is what the snapshot has to put back on a revert.
    await this.repointLegacyIds(organizationId, movedLegacyIds, survivorId);

    // After the re-point, not before it: the survivor has just inherited legacy
    // rows it has never derived, and they still hold the loser's values.
    await refreshPartyMirrors(this.db, organizationId, survivorId);

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
        conflicts: plan.conflicts as Record<string, { kept: unknown; discarded: unknown }>,
        snapshot: snapshot as unknown as Record<string, unknown>,
      })
      .returning({ partyMergeId: partyMerges.partyMergeId });

    await this.closeCandidate(organizationId, survivorId, mergedId, "MERGED", input.userId);

    // logCritical, not log: a merge is destructive and performed unattended, so
    // an audit write that fails must stop it rather than leave it unrecorded.
    await this.audit.logCritical({
      action: "party.merge",
      userId: input.userId ?? "system",
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: survivorId,
      before: snapshot as unknown as Record<string, unknown>,
      metadata: {
        mergedPartyId: mergedId,
        decidedBy: input.decidedBy,
        confidence: assessment.score,
        signals: assessment.signals,
        conflicts: Object.keys(plan.conflicts),
      },
    });

    return {
      partyMergeId: record?.partyMergeId ?? "",
      survivorPartyId: survivorId,
      mergedPartyId: mergedId,
      conflicts: plan.conflicts as Record<string, { kept: unknown; discarded: unknown }>,
    };
  }

  /**
   * Puts both records back exactly as they were.
   *
   * Restores from the snapshot rather than recomputing: working out what a merge
   * changed by inspecting the current state cannot distinguish a field the merge
   * filled from one a user edited afterwards, and would silently discard the
   * edit.
   */
  async revert(
    organizationId: string,
    partyMergeId: string,
    userId?: string,
  ): Promise<{ survivorPartyId: string; restoredPartyId: string }> {
    const [record] = await this.db
      .select()
      .from(partyMerges)
      .where(
        and(
          eq(partyMerges.organizationId, organizationId),
          eq(partyMerges.partyMergeId, partyMergeId),
          isNull(partyMerges.revertedAt),
        ),
      )
      .limit(1);

    if (!record) throw new NotFoundException("Merge not found");

    const snapshot = record.snapshot as unknown as MergeSnapshot;
    const survivorBefore = snapshot.survivorBefore;
    const mergedBefore = snapshot.mergedBefore;

    await updatePartyWithMirror(this.db, organizationId, record.survivorPartyId, {
      name: String(survivorBefore.name ?? ""),
      legalName: (survivorBefore.legalName ?? null) as string | null,
      displayName: (survivorBefore.displayName ?? null) as string | null,
      taxNumber: (survivorBefore.taxNumber ?? null) as string | null,
      website: (survivorBefore.website ?? null) as string | null,
      email: (survivorBefore.email ?? null) as string | null,
      phone: (survivorBefore.phone ?? null) as string | null,
      notes: (survivorBefore.notes ?? null) as string | null,
      customFields: (survivorBefore.customFields ?? null) as Record<string, unknown> | null,
    });

    await restorePartyWithMirror(this.db, organizationId, record.mergedPartyId, {
      name: String(mergedBefore.name ?? ""),
      legalName: (mergedBefore.legalName ?? null) as string | null,
      displayName: (mergedBefore.displayName ?? null) as string | null,
      taxNumber: (mergedBefore.taxNumber ?? null) as string | null,
      website: (mergedBefore.website ?? null) as string | null,
      email: (mergedBefore.email ?? null) as string | null,
      phone: (mergedBefore.phone ?? null) as string | null,
      notes: (mergedBefore.notes ?? null) as string | null,
      customFields: (mergedBefore.customFields ?? null) as Record<string, unknown> | null,
    });

    if (snapshot.movedContactIds.length > 0)
      await this.db
        .update(partyContacts)
        .set({ partyId: record.mergedPartyId })
        .where(
          and(
            eq(partyContacts.organizationId, organizationId),
            inArray(partyContacts.partyContactId, snapshot.movedContactIds),
          ),
        );

    await this.repointLegacyIds(
      organizationId,
      snapshot.movedLegacyIds ?? NO_LEGACY_IDS,
      record.mergedPartyId,
    );

    // Both sides, after the ids move back: the restored party has re-acquired
    // legacy rows the survivor was deriving a moment ago.
    await refreshPartyMirrors(this.db, organizationId, record.mergedPartyId);
    await refreshPartyMirrors(this.db, organizationId, record.survivorPartyId);

    // Only the roles the merge added: one the survivor already held is its own.
    if (snapshot.addedRoles.length > 0)
      await this.db
        .delete(partyRoles)
        .where(
          and(
            eq(partyRoles.organizationId, organizationId),
            eq(partyRoles.partyId, record.survivorPartyId),
            inArray(partyRoles.role, snapshot.addedRoles),
          ),
        );

    await this.db
      .update(partyMerges)
      .set({ revertedAt: new Date(), revertedByUserId: userId ?? null })
      .where(eq(partyMerges.partyMergeId, partyMergeId));

    await this.audit.logCritical({
      action: "party.merge.revert",
      userId: userId ?? "system",
      orgId: organizationId,
      resourceType: "business_party",
      resourceId: record.survivorPartyId,
      metadata: {
        partyMergeId,
        restoredPartyId: record.mergedPartyId,
        originallyDecidedBy: record.decidedBy,
      },
    });

    return {
      survivorPartyId: record.survivorPartyId,
      restoredPartyId: record.mergedPartyId,
    };
  }

  private async legacyIdsOf(
    organizationId: string,
    partyId: string,
  ): Promise<LegacyIdsByKind> {
    const [lead, client, contact] = await Promise.all([
      this.db
        .select({ id: leadPartyMap.leadId })
        .from(leadPartyMap)
        .where(
          and(
            eq(leadPartyMap.organizationId, organizationId),
            eq(leadPartyMap.partyId, partyId),
          ),
        ),
      this.db
        .select({ id: clientPartyMap.clientId })
        .from(clientPartyMap)
        .where(
          and(
            eq(clientPartyMap.organizationId, organizationId),
            eq(clientPartyMap.partyId, partyId),
          ),
        ),
      this.db
        .select({ id: contactPartyMap.contactId })
        .from(contactPartyMap)
        .where(
          and(
            eq(contactPartyMap.organizationId, organizationId),
            eq(contactPartyMap.partyId, partyId),
          ),
        ),
    ]);

    return {
      lead: lead.map((row) => row.id),
      client: client.map((row) => row.id),
      contact: contact.map((row) => row.id),
    };
  }

  private async repointLegacyIds(
    organizationId: string,
    ids: LegacyIdsByKind,
    partyId: string,
  ): Promise<void> {
    if (ids.lead.length > 0)
      await this.db
        .update(leadPartyMap)
        .set({ partyId })
        .where(
          and(
            eq(leadPartyMap.organizationId, organizationId),
            inArray(leadPartyMap.leadId, ids.lead),
          ),
        );

    if (ids.client.length > 0)
      await this.db
        .update(clientPartyMap)
        .set({ partyId })
        .where(
          and(
            eq(clientPartyMap.organizationId, organizationId),
            inArray(clientPartyMap.clientId, ids.client),
          ),
        );

    if (ids.contact.length > 0)
      await this.db
        .update(contactPartyMap)
        .set({ partyId })
        .where(
          and(
            eq(contactPartyMap.organizationId, organizationId),
            inArray(contactPartyMap.contactId, ids.contact),
          ),
        );
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
}
