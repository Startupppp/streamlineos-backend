import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  partyContacts,
  partyMerges,
  partyRoles,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { restoreIdentifiers } from "./party-identifiers";
import { refreshEmployerColumns } from "./party-legacy-employer";
import {
  refreshPartyMirrors,
  restorePartyWithMirror,
  updatePartyWithMirror,
} from "./party-legacy-writer";
import { repointLegacyIds, type LegacyIdsByKind } from "./party-merge-legacy-ids";

interface MergeSnapshot {
  survivorBefore: Record<string, unknown>;
  mergedBefore: Record<string, unknown>;
  movedContactIds: string[];
  addedRoles: string[];
  movedIdentifierIds?: string[];
  movedEmployeePartyIds?: string[];
  movedLegacyIds?: LegacyIdsByKind;
}

const NO_LEGACY_IDS: LegacyIdsByKind = { lead: [], client: [], contact: [], organisation: [] };

@Injectable()
export class PartyRevertService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

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

    await restoreIdentifiers(
      this.db,
      organizationId,
      snapshot.movedIdentifierIds ?? [],
      record.mergedPartyId,
    );

    await repointLegacyIds(
      this.db,
      organizationId,
      snapshot.movedLegacyIds ?? NO_LEGACY_IDS,
      record.mergedPartyId,
    );

    const movedEmployeePartyIds = snapshot.movedEmployeePartyIds ?? [];
    if (movedEmployeePartyIds.length > 0) {
      await this.db
        .update(businessParties)
        .set({ employerPartyId: record.mergedPartyId })
        .where(
          and(
            eq(businessParties.organizationId, organizationId),
            inArray(businessParties.partyId, movedEmployeePartyIds),
          ),
        );
      await refreshEmployerColumns(this.db, organizationId, movedEmployeePartyIds);
    }

    await refreshPartyMirrors(this.db, organizationId, record.mergedPartyId);
    await refreshPartyMirrors(this.db, organizationId, record.survivorPartyId);

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
}
