import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { deals, tickets, crmPipelines } from "../../db/schema";
import { businessParties } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { CrmBlueprintsService } from "../crm/metadata/crm-blueprints.service";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { toMinorUnits } from "../deals/deal-stage-ledger";
import type { TransitionLeadStatusInput } from "./dto/lead-mutations.schemas";
import { updateMirroredLeads } from "../party/party-legacy-leads";
import { isLegacyResolved, resolveLegacyParty } from "../party/party-legacy-seam";
import type { LeadInsert, LeadRow } from "../party/party-legacy-writer";
import { LeadConversionService } from "./lead-conversion.service";
import { LEAD_MIRROR_DEFAULTS, loadLeadView } from "./lead-party-reader";

export type TransitionLeadStatusResult =
  | { ok: true; lead: LeadRow }
  | { ok: false; reason: "already_converted" | "stale_or_missing" | "lost_reason_required" };

@Injectable()
export class LeadStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly crmMetadata: CrmMetadataService,
    private readonly blueprints: CrmBlueprintsService,
    private readonly planLimits: PlanLimitsService,
    private readonly conversion: LeadConversionService,
  ) {}

  private async getSemantics(orgId: string) {
    const aggregate = await this.crmMetadata.getAggregate(orgId);
    const statusOptions = aggregate.options.filter((o) => o.type === "lead_status");
    return resolveLeadStatusSemantics(
      statusOptions.map((o) => ({
        key: o.key,
        isTerminal: o.isTerminal ?? false,
        metadata: o.metadata as Record<string, unknown> | null,
      })),
    );
  }

  private async ensureDealForLead(orgId: string, lead: LeadRow): Promise<void> {
    const existingDeal = await this.db.query.deals.findFirst({
      where: and(eq(deals.leadId, lead.id), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
    });
    if (existingDeal) return;
    await this.planLimits.assertWithinLimit(orgId, "crmDeals");
    await this.db.insert(deals).values({
      orgId,
      leadId: lead.id,
      name: `${lead.name}${lead.company ? " - " + lead.company : ""}`,
      // `value` is generated from this column now, so writing it would error.
      valueMinor: toMinorUnits(lead.potentialValue || lead.investmentInterest),
      stage: "LEAD",
      contactPerson: lead.name,
      contactEmail: lead.email,
      contactPhone: lead.phone,
      assignedToId: null,
    });
  }


  async transitionLeadStatus(
    orgId: string,
    userId: string,
    leadId: number,
    input: TransitionLeadStatusInput,
  ): Promise<TransitionLeadStatusResult> {
    const semantics = await this.getSemantics(orgId);
    const isConverted = semantics.convertedKeys.includes(input.status);
    const isLost = semantics.lostKeys.includes(input.status);

    const existing = await loadLeadView(this.db, orgId, leadId);

    if (isConverted && existing && semantics.convertedKeys.includes(existing.status)) {
      return { ok: false, reason: "already_converted" };
    }

    if (existing) {
      const defaultPipeline = await this.db
        .select({ id: crmPipelines.id })
        .from(crmPipelines)
        .where(and(eq(crmPipelines.orgId, orgId), eq(crmPipelines.type, "lead"), eq(crmPipelines.isDefault, true), eq(crmPipelines.isActive, true)))
        .limit(1)
        .then((r) => r[0]);

      if (defaultPipeline) {
        const leadRecord: Record<string, unknown> = { ...existing };
        const transitionCheck = await this.blueprints.assertTransitionAllowed(
          orgId,
          defaultPipeline.id,
          existing.status,
          input.status,
          leadRecord,
        );
        if (!transitionCheck.allowed) {
          throw new BadRequestException({
            message: "Status transition blocked: missing required fields",
            missingFields: transitionCheck.missingFields,
          });
        }
      }
    }

    if (isLost && !input.lostReason) {
      const aggregate = await this.crmMetadata.getAggregate(orgId);
      const lostReasonOptions = aggregate.options.filter((o) => o.type === "lost_reason");
      if (lostReasonOptions.length > 0) {
        return { ok: false, reason: "lost_reason_required" };
      }
    }

    const updateData: Partial<LeadInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };
    if (isConverted) updateData.convertedAt = new Date();
    if (isLost && input.lostReason) updateData.lostReason = input.lostReason;

    /*
     * The optimistic check is a locking SELECT rather than the UPDATE's own
     * predicate, because the write goes through the party first and a mirrored
     * write is addressed by id. `FOR UPDATE` holds the row for the rest of the
     * transaction, so two concurrent transitions still serialise and the loser
     * still sees `stale_or_missing` rather than silently overwriting.
     *
     * The row it locks is the party's, not the mirror's: locking the record the
     * write does not address would leave two transitions free to interleave on
     * the one it does.
     */
    const updated = await this.db.transaction(async (tx) => {
      const resolved = await resolveLegacyParty(tx, orgId, {
        kind: "LEAD",
        legacyId: leadId,
      });
      if (!isLegacyResolved(resolved)) return undefined;

      const [claimed] = await tx
        .select({ stage: businessParties.lifecycleStage })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.partyId, resolved.party.partyId),
            eq(businessParties.organizationId, orgId),
            isNull(businessParties.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!claimed) return undefined;
      if (
        input.expectedStatus &&
        (claimed.stage ?? LEAD_MIRROR_DEFAULTS.status) !== input.expectedStatus
      )
        return undefined;

      const [row] = await updateMirroredLeads(tx, orgId, [leadId], updateData);
      return row;
    });

    if (!updated) return { ok: false, reason: "stale_or_missing" };

    const isQualifyingForDeal =
      !semantics.convertedKeys.includes(input.status) &&
      !semantics.lostKeys.includes(input.status) &&
      semantics.activeKeys.indexOf(input.status) >= 2;

    if (isQualifyingForDeal) {
      await this.ensureDealForLead(orgId, updated);
    }

    if (isConverted) await this.conversion.convert(orgId, userId, updated, input);

    return { ok: true, lead: updated };
  }

  async changeStatus(
    orgId: string,
    userId: string,
    leadId: number,
    input: TransitionLeadStatusInput,
  ): Promise<TransitionLeadStatusResult> {
    const result = await this.transitionLeadStatus(
      orgId,
      userId,
      leadId,
      input,
    );
    if (!result.ok) return result;

    await this.cache.invalidateNamespace(`leads:${orgId}`);
    await this.cache.invalidate(CACHE_KEYS.salesDashboard(orgId));

    this.audit.log({
      action: "lead.status_changed",
      userId,
      orgId,
      targetId: String(leadId),
      targetType: "lead",
      metadata: { newStatus: input.status, lostReason: input.lostReason },
    });

    return result;
  }
}
