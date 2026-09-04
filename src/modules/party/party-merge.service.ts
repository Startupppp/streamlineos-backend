import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
} from "./party-identifiers";
import { chooseSurvivor, orderPair, planMerge } from "./party-merge-plan";
import { refreshEmployerColumns, repointEmployerParties } from "./party-legacy-employer";
import {
  refreshPartyMirrors,
  softDeletePartyWithMirror,
  updatePartyWithMirror,
} from "./party-legacy-writer";
import { legacyIdsOf, repointLegacyIds } from "./party-merge-legacy-ids";
import type { MergeSnapshot } from "./dto/party-merge-snapshot.schema";

export interface MergeOutcome {
  partyMergeId: string;
  survivorPartyId: string;
  mergedPartyId: string;
  conflicts: Record<string, { kept: unknown; discarded: unknown }>;
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
    row: Record<string, unknown>,
    identifiers: readonly IdentifierClaim[],
  ): PartyFingerprint {
    return {
      partyId: String(row.partyId),
      name: String(row.name ?? ""),
      legalName: (row.legalName ?? null) as string | null,
      identifiers,
      email: (row.email ?? null) as string | null,
      phone: (row.phone ?? null) as string | null,
      taxNumber: (row.taxNumber ?? null) as string | null,
      website: (row.website ?? null) as string | null,
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
        conflicts: plan.conflicts as Record<string, { kept: unknown; discarded: unknown }>,
        snapshot,
      })
      .returning({ partyMergeId: partyMerges.partyMergeId });

    await this.closeCandidate(organizationId, survivorId, mergedId, "MERGED", input.userId);

    await this.audit.logCritical({
      action: "party.merge",
      userId: input.userId ?? "system",
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
    });

    return {
      partyMergeId: record?.partyMergeId ?? "",
      survivorPartyId: survivorId,
      mergedPartyId: mergedId,
      conflicts: plan.conflicts as Record<string, { kept: unknown; discarded: unknown }>,
    };
  }
}
