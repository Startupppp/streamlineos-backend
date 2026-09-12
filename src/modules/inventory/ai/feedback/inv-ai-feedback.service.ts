import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { invAiFeedback } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AiUsageService } from "../../../ai/core/services/ai-usage.service";
import type {
  CreateInvAiFeedbackInput,
  InvAiFeedbackSummaryQuery,
} from "./dto/inv-ai-feedback.schemas";

/**
 * F6 — the audit trail on the other side of an AI answer.
 *
 * ## Why the correlation id is checked rather than stored
 *
 * The whole value of this table is that a complaint resolves to a call. So a
 * verdict is only accepted against a call the **gateway** recorded for **this
 * organisation**, recently. Three things follow from that, and each is a bug
 * that would otherwise be invisible:
 *
 *   * a correlation id nobody's gateway ever issued is refused, so the table
 *     cannot fill with reports about answers that were never given;
 *   * a correlation id from another organisation is refused, because the lookup
 *     is org-scoped — feedback is not a channel for asserting things about
 *     somebody else's usage;
 *   * the cost, tokens and credits are read **from the log**, never from the
 *     request. A client-supplied cost figure is a number that means nothing and
 *     would be quoted in a report as though it did.
 *
 * ## What never leaves
 *
 * Nothing here egresses to a model provider, and nothing here is put in a
 * prompt. The row holds ids, versions, figures and a note the reporter typed.
 * The note in particular is tenant free-text: it is stored and shown, and it is
 * never fed back into a model as context, because a "this answer was unsafe"
 * report is the single most attractive place to hide an instruction.
 */

/** Dollars to micro-dollars, as an integer. Money never travels as a float. */
function toMicroUsd(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 1_000_000);
}

export interface InvAiFeedbackSummaryRow {
  surface: string;
  useful: number;
  wrong: number;
  stale: number;
  /**
   * Reported separately and never folded into a ratio. An unsafe answer is not
   * a low score; it is an incident, and a surface with one of these and ninety
   * `USEFUL`s is not a surface performing at 99%.
   */
  unsafe: number;
  total: number;
  /** `USEFUL / (USEFUL + WRONG + STALE)`. Deliberately excludes `UNSAFE`. */
  usefulRatio: number | null;
}

@Injectable()
export class InvAiFeedbackService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly usage: AiUsageService,
  ) {}

  async submit(user: CurrentUserContext, input: CreateInvAiFeedbackInput) {
    const { orgId, userId } = user;

    const call = await this.usage.findRecentCall(orgId, input.correlationId);
    if (!call) {
      // Deliberately not a 404: the caller is inside the correct tenant and is
      // telling us about something that, as far as the gateway is concerned,
      // did not happen. Saying so is more useful than a silent accept, and it
      // is not an existence oracle — a correlation id is not a resource.
      throw new BadRequestException(
        "That answer could not be found in this organisation's recent AI activity, so there is nothing to attach this feedback to.",
      );
    }

    const [row] = await this.db
      .insert(invAiFeedback)
      .values({
        orgId,
        userId,
        surface: input.surface,
        verdict: input.verdict,
        // The gateway's own record of what this call was and cost, not the
        // client's account of it.
        feature: call.feature,
        model: call.model,
        totalTokens: call.totalTokens,
        credits: Math.round(call.creditsMilli / 1000),
        costMicroUsd: toMicroUsd(call.estimatedCostUsd),
        promptKey: input.promptKey,
        promptVersion: input.promptVersion,
        contractVersion: input.contractVersion,
        correlationId: input.correlationId,
        evidenceHash: input.evidenceHash ?? null,
        note: input.note ?? null,
      })
      .onConflictDoUpdate({
        // One verdict per person per answer. Somebody who changes their mind is
        // one reporter with a new opinion, not two reporters — and a UI that
        // double-submits does not become two data points.
        target: [invAiFeedback.orgId, invAiFeedback.userId, invAiFeedback.correlationId],
        set: {
          verdict: input.verdict,
          note: input.note ?? null,
          surface: input.surface,
          evidenceHash: input.evidenceHash ?? null,
          createdAt: new Date(),
        },
      })
      .returning({
        id: invAiFeedback.id,
        verdict: invAiFeedback.verdict,
        surface: invAiFeedback.surface,
        createdAt: invAiFeedback.createdAt,
      });

    return row;
  }

  /**
   * How each surface is doing, and — separately — whether anybody called one
   * unsafe.
   *
   * The ratio omits `UNSAFE` on purpose. Including it would let a surface with a
   * safety report and a hundred happy readers report 99%, which is exactly the
   * number somebody would quote in a review and exactly the wrong one.
   */
  async summary(
    orgId: string,
    query: InvAiFeedbackSummaryQuery,
  ): Promise<{ days: number; surfaces: InvAiFeedbackSummaryRow[]; unsafeTotal: number }> {
    const since = new Date(Date.now() - query.days * 86_400_000);
    const conditions = [eq(invAiFeedback.orgId, orgId), gte(invAiFeedback.createdAt, since)];
    if (query.surface) conditions.push(eq(invAiFeedback.surface, query.surface));

    const rows = await this.db
      .select({
        surface: invAiFeedback.surface,
        useful: sql<number>`COUNT(*) FILTER (WHERE ${invAiFeedback.verdict} = 'USEFUL')::int`,
        wrong: sql<number>`COUNT(*) FILTER (WHERE ${invAiFeedback.verdict} = 'WRONG')::int`,
        stale: sql<number>`COUNT(*) FILTER (WHERE ${invAiFeedback.verdict} = 'STALE')::int`,
        unsafe: sql<number>`COUNT(*) FILTER (WHERE ${invAiFeedback.verdict} = 'UNSAFE')::int`,
        total: count(),
      })
      .from(invAiFeedback)
      .where(and(...conditions))
      .groupBy(invAiFeedback.surface);

    const surfaces = rows.map((row) => {
      const rated = row.useful + row.wrong + row.stale;
      return {
        surface: row.surface,
        useful: row.useful,
        wrong: row.wrong,
        stale: row.stale,
        unsafe: row.unsafe,
        total: row.total,
        usefulRatio: rated > 0 ? Number((row.useful / rated).toFixed(4)) : null,
      };
    });

    return {
      days: query.days,
      surfaces,
      unsafeTotal: surfaces.reduce((sum, row) => sum + row.unsafe, 0),
    };
  }
}
