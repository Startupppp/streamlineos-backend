import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { businessParties, crmOrgPartyMap } from "../../../db/schema/party";
import { updateMirroredOrganizations } from "../../party/party-legacy-orgs";
import { PartyMergeService } from "../../party/party-merge.service";
import { isLegacyResolved, resolveLegacyParty } from "../../party/party-legacy-seam";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { MergeOrgsInput } from "./dto/organizations.schemas";

@Injectable()
export class CrmOrganizationsMergeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly merges: PartyMergeService,
  ) {}

  async mergeOrganizations(orgId: string, input: MergeOrgsInput, actorId: string) {
    const [primaryPartyId, duplicatePartyId] = await Promise.all([
      this.partyOf(orgId, input.primaryId),
      this.partyOf(orgId, input.duplicateId),
    ]);

    if (!primaryPartyId) throw new NotFoundException("Primary organization not found in this org");
    if (!duplicatePartyId)
      throw new NotFoundException("Duplicate organization not found in this org");

    const outcome = await this.merges.merge(orgId, {
      leftPartyId: primaryPartyId,
      rightPartyId: duplicatePartyId,
      decidedBy: "USER",
      userId: actorId,
      preferSurvivorPartyId: primaryPartyId,
    });

    await this.reparentSubsidiaries(orgId, input.duplicateId, input.primaryId);

    await this.invalidateOrgCaches(orgId);

    return {
      success: true,
      survivorId: input.primaryId,
      mergedId: input.duplicateId,
      partyMergeId: outcome.partyMergeId,
      conflicts: outcome.conflicts,
    };
  }

  private async partyOf(orgId: string, crmOrganizationId: number): Promise<string | null> {
    const resolution = await resolveLegacyParty(this.db, orgId, {
      kind: "ORGANISATION",
      legacyId: crmOrganizationId,
    });
    if (!isLegacyResolved(resolution) || resolution.party.deletedAt) return null;
    return resolution.party.partyId;
  }

  private async invalidateOrgCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationsListNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationDetailNamespace(orgId)),
    ]);
  }

  private async reparentSubsidiaries(
    orgId: string,
    mergedId: number,
    survivorId: number,
  ): Promise<void> {
    const mergedPartyId = await this.partyOf(orgId, mergedId);
    const [mergedMap] = mergedPartyId
      ? [{ partyId: mergedPartyId }]
      : await this.db
          .select({ partyId: crmOrgPartyMap.partyId })
          .from(crmOrgPartyMap)
          .where(
            and(
              eq(crmOrgPartyMap.organizationId, orgId),
              eq(crmOrgPartyMap.crmOrganizationId, mergedId),
            ),
          )
          .limit(1);
    if (!mergedMap) return;

    const children = await this.db
      .select({ id: crmOrgPartyMap.crmOrganizationId })
      .from(businessParties)
      .innerJoin(
        crmOrgPartyMap,
        and(
          eq(crmOrgPartyMap.partyId, businessParties.partyId),
          eq(crmOrgPartyMap.organizationId, businessParties.organizationId),
        ),
      )
      .where(
        and(
          eq(businessParties.organizationId, orgId),
          eq(businessParties.parentPartyId, mergedMap.partyId),
        ),
      );
    if (children.length === 0) return;
    await updateMirroredOrganizations(
      this.db,
      orgId,
      children.map((child) => child.id),
      { parentId: survivorId },
    );
  }
}
