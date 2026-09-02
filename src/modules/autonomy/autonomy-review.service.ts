import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, desc, eq, isNotNull, notInArray, sql, type SQL } from "drizzle-orm";
import { keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyCorrections,
  autonomySwitches,
  businessParties,
  deals,
} from "../../db/schema";
import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { AutonomyReversalService } from "./autonomy-reversal.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";
import { ROUTINE_KINDS, type ListDecisionsQuery, type ReverseDecisionInput, type SetSwitchInput } from "./dto/autonomy-review.schemas";

@Injectable()
export class AutonomyReviewService {
  private readonly logger = new Logger("AutonomyReview");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reversal: AutonomyReversalService,
    @Optional()
    @Inject(AutonomyHoldService)
    private readonly holds?: AutonomyHoldService,
  ) {}

  async listDecisions(
    organizationId: string,
    userId: string,
    query: ListDecisionsQuery,
    scope: DataScope,
  ) {
    const { limit, cursor, kind, outcome, partyId, dealId, assignedToId, reversedOnly, includeRoutine } = query;
    const position = decodeCursor(cursor);

    const filters: (SQL | undefined)[] = [
      eq(autonomousDecisions.organizationId, organizationId),
      kind ? eq(autonomousDecisions.kind, kind) : undefined,
      outcome ? eq(autonomousDecisions.outcome, outcome) : undefined,
      partyId ? eq(autonomousDecisions.partyId, partyId) : undefined,
      dealId ? eq(autonomousDecisions.dealId, dealId) : undefined,
      reversedOnly ? isNotNull(autonomousDecisions.reversedAt) : undefined,
      assignedToId ? eq(deals.assignedToId, assignedToId) : undefined,
      !includeRoutine && !kind
        ? notInArray(autonomousDecisions.kind, [...ROUTINE_KINDS])
        : undefined,
      this.scopePredicate(scope, organizationId, userId),
    ];

    const conditions = and(...filters.filter((c): c is SQL => c !== undefined));

    const keyset = position
      ? and(
          conditions,
          keysetBefore(autonomousDecisions.decidedAt, autonomousDecisions.autonomousDecisionId, position),
        )
      : conditions;

    const rows = await this.db
      .select({
        autonomousDecisionId: autonomousDecisions.autonomousDecisionId,
        kind: autonomousDecisions.kind,
        outcome: autonomousDecisions.outcome,
        summary: autonomousDecisions.summary,
        confidence: autonomousDecisions.confidence,
        reversibility: autonomousDecisions.reversibility,
        triggerType: autonomousDecisions.triggerType,
        triggerId: autonomousDecisions.triggerId,
        partyId: autonomousDecisions.partyId,
        dealId: autonomousDecisions.dealId,
        activityId: autonomousDecisions.activityId,
        decidedAt: autonomousDecisions.decidedAt,
        reversedAt: autonomousDecisions.reversedAt,
        reversedByUserId: autonomousDecisions.reversedByUserId,
        reversedReason: autonomousDecisions.reversedReason,
        model: autonomousDecisions.model,
        promptVersion: autonomousDecisions.promptVersion,
        dealName: deals.name,
        partyName: businessParties.name,
      })
      .from(autonomousDecisions)
      .leftJoin(
        deals,
        and(
          eq(deals.orgId, autonomousDecisions.organizationId),
          sql`${deals.id}::text = ${autonomousDecisions.dealId}`,
        ),
      )
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, autonomousDecisions.organizationId),
          eq(businessParties.partyId, autonomousDecisions.partyId),
        ),
      )
      .where(keyset)
      .orderBy(desc(autonomousDecisions.decidedAt), desc(autonomousDecisions.autonomousDecisionId))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.decidedAt.toISOString(),
      id: row.autonomousDecisionId,
    }));
  }

  private scopePredicate(scope: DataScope, organizationId: string, userId: string): SQL | undefined {
    if (scope === "all") return undefined;
    return applyScope(scope, organizationId, userId, { ownerColumn: deals.assignedToId });
  }

  async getDecision(organizationId: string, decisionId: string) {
    const [row] = await this.db
      .select()
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Decision not found");

    const corrections = await this.db
      .select()
      .from(autonomyCorrections)
      .where(
        and(
          eq(autonomyCorrections.organizationId, organizationId),
          eq(autonomyCorrections.autonomousDecisionId, decisionId),
        ),
      )
      .orderBy(desc(autonomyCorrections.createdAt))
      .limit(20);

    return { ...row, corrections };
  }

  async reverseDecision(
    organizationId: string,
    userId: string,
    decisionId: string,
    input: ReverseDecisionInput,
  ) {
    return this.reversal.reverseDecision(organizationId, userId, decisionId, input);
  }

  async listSwitches(organizationId: string) {
    const rows = await this.db
      .select({
        organizationId: autonomySwitches.organizationId,
        kind: autonomySwitches.kind,
        enabled: autonomySwitches.enabled,
        reason: autonomySwitches.reason,
        updatedAt: autonomySwitches.updatedAt,
      })
      .from(autonomySwitches)
      .where(
        sql`${autonomySwitches.organizationId} IS NULL OR ${autonomySwitches.organizationId} = ${organizationId}`,
      );

    const scoped = switchesFor(organizationId, rows as SwitchRow[]);

    return {
      switches: rows,
      effective: (["task.extracted", "stage.advanced", "party.created", "activity.logged", "quote.sent"] as const).map(
        (kind) => ({ kind, ...resolveSwitch(organizationId, kind, scoped) }),
      ),
    };
  }

  async setSwitch(organizationId: string, userId: string, input: SetSwitchInput) {
    await this.db
      .insert(autonomySwitches)
      .values({
        organizationId,
        kind: input.kind,
        enabled: input.enabled,
        reason: input.reason ?? null,
        updatedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [autonomySwitches.organizationId, autonomySwitches.kind],
        set: {
          enabled: input.enabled,
          reason: input.reason ?? null,
          updatedByUserId: userId,
          updatedAt: new Date(),
        },
      });

    if (!input.enabled && this.holds) {
      const cancelled = await this.holds.cancelInFlight(organizationId, userId, input.kind);
      if (cancelled > 0)
        this.logger.warn(
          `kill switch on ${input.kind} cancelled ${cancelled} hold(s) already in flight`,
        );
    }

    return this.listSwitches(organizationId);
  }

  async recordFieldCorrection(input: {
    organizationId: string;
    userId: string;
    kind: DecisionKind;
    field: string;
    systemValue: string | null;
    humanValue: string | null;
    dealId?: string | null;
    partyId?: string | null;
    consented?: boolean;
  }): Promise<void> {
    const [decision] = await this.db
      .select({ id: autonomousDecisions.autonomousDecisionId })
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, input.organizationId),
          eq(autonomousDecisions.kind, input.kind),
          eq(autonomousDecisions.outcome, "applied"),
          input.dealId ? eq(autonomousDecisions.dealId, input.dealId) : undefined,
          input.partyId ? eq(autonomousDecisions.partyId, input.partyId) : undefined,
        ),
      )
      .orderBy(desc(autonomousDecisions.decidedAt))
      .limit(1);

    if (!decision) return;

    await this.db.insert(autonomyCorrections).values({
      organizationId: input.organizationId,
      autonomousDecisionId: decision.id,
      kind: input.kind,
      correctionType: "edit",
      field: input.field,
      systemValue: input.systemValue,
      humanValue: input.humanValue,
      correctedByUserId: input.userId,
      consented: input.consented ?? false,
    });
  }
}
