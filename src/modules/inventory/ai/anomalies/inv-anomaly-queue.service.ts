import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { invAiInsights } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { anomalyVisibilityPredicate } from "./inv-anomaly-visibility";
import type { InvEvidenceReference } from "../dto/inv-ai-contract";
import { detectorFor, type InvAnomalyDetector } from "./inv-anomaly-detectors";
import type { ListAnomaliesInput, ReviewAnomalyInput } from "./dto/inv-anomaly.schemas";

/**
 * F3 — the anomaly queue.
 *
 * This service reads and it reviews. It does not, and structurally cannot, post
 * stock: it injects a database handle, a cache and the warehouse scope resolver,
 * and nothing else. There is no stock engine here, no adjustment service, no
 * path to a ledger write — which is the only way "an anomaly never posts stock"
 * is a property of the code rather than a promise in a comment.
 * `__tests__/inv-anomaly-queue.spec.ts` pins that by reading this file.
 *
 * ## The visibility rule
 *
 * A finding either names a warehouse or it does not, and the two are different
 * claims.
 *
 *   * **Named** — a late purchase order, an expiring lot whose stock sits in one
 *     place. It is visible to a caller who holds that warehouse, exactly as the
 *     underlying record is on its own screen.
 *   * **Unnamed** — a demand series summed across every site, a SKU whose total
 *     on-hand went negative. The figure describes the organisation. It is shown
 *     only to a caller whose scope *is* the organisation.
 *
 * That second half is the part it would be easy to get wrong, and getting it
 * wrong is a disclosure: an operator assigned to one depot would otherwise read
 * org-wide demand and stock positions from the queue, which is information the
 * stock screens deny them. The predicate is built in SQL and bound to the
 * asker's resolved scope, never applied after the rows arrive.
 *
 * A restricted caller is told, as a flag rather than a count, that org-wide
 * signals exist and are not theirs to see — otherwise the honest gate reads as a
 * broken screen.
 */

export interface InvAnomalyDetectorView {
  type: string;
  label: string;
  formula: string;
  windowLabel: string;
  severityRule: string;
  href: string;
}

export interface InvAnomalyRow {
  id: number;
  type: string;
  severity: string;
  status: "NEW" | "ACKNOWLEDGED" | "DISMISSED";
  title: string;
  body: string;
  warehouseId: number | null;
  /** The window this finding was raised under, which may predate a change. */
  windowDays: number | null;
  evidenceHash: string | null;
  /** Records the finding points at, resolvable on their own screens. */
  evidence: InvEvidenceReference[];
  /** What the detector claims and how, or `null` for a retired detector. */
  detector: InvAnomalyDetectorView | null;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

export interface InvAnomalyPage {
  items: InvAnomalyRow[];
  total: number;
  page: number;
  totalPages: number;
  /**
   * The caller's access is limited to specific warehouses, so organisation-wide
   * findings are excluded. A flag rather than a count: telling somebody how many
   * rows they cannot see is still telling them something about those rows.
   */
  orgWideSignalsHidden: boolean;
}

/**
 * Which `sourceRefs` key carries which kind of record.
 *
 * These are the names `collectCandidates` actually writes — `variantId`, not
 * `productVariantId`. Guessing them here would produce an empty evidence list
 * on every row, which renders as "this finding cites nothing" rather than as
 * the bug it would be.
 */
const EVIDENCE_KEYS: ReadonlyArray<[InvEvidenceReference["kind"], string]> = [
  ["product_variant", "variantId"],
  ["vendor", "vendorId"],
  ["lot", "lotId"],
  ["purchase_order", "poId"],
  ["warehouse", "warehouseId"],
];

function evidenceFrom(
  insightId: number,
  sourceRefs: Record<string, unknown> | null,
): InvEvidenceReference[] {
  const refs: InvEvidenceReference[] = [{ kind: "insight", id: insightId }];
  const source = sourceRefs ?? {};
  for (const [kind, key] of EVIDENCE_KEYS) {
    const raw = source[key];
    const id = typeof raw === "string" ? Number(raw) : raw;
    if (typeof id === "number" && Number.isInteger(id) && id > 0) refs.push({ kind, id });
  }
  return refs;
}

function toDetectorView(detector: InvAnomalyDetector | null): InvAnomalyDetectorView | null {
  if (!detector) return null;
  return {
    type: detector.type,
    label: detector.label,
    formula: detector.formula,
    windowLabel: detector.windowLabel,
    severityRule: detector.severityRule,
    href: detector.href,
  };
}

@Injectable()
export class InvAnomalyQueueService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly cache: CacheService,
  ) {}

  async list(user: CurrentUserContext, filters: ListAnomaliesInput): Promise<InvAnomalyPage> {
    const { orgId, userId } = user;

    // A named warehouse is checked before anything is read. Outside the
    // caller's scope this throws 404 — the same answer the warehouse's own
    // screen gives, and never a 403 that would confirm it exists.
    if (filters.warehouseId !== undefined) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, filters.warehouseId);
    }

    const scope = await this.warehouseScope.resolve(orgId, userId);
    const restricted = scope !== null;

    const conditions: SQL[] = [eq(invAiInsights.orgId, orgId), anomalyVisibilityPredicate(scope)];
    if (filters.status) conditions.push(eq(invAiInsights.status, filters.status));
    if (filters.type) conditions.push(eq(invAiInsights.insightType, filters.type));
    if (filters.severity) conditions.push(eq(invAiInsights.severity, filters.severity));
    if (filters.warehouseId !== undefined) {
      conditions.push(eq(invAiInsights.warehouseId, filters.warehouseId));
    }

    const where = and(...conditions);
    const offset = (filters.page - 1) * filters.limit;

    const [rows, [countRow]] = await Promise.all([
      this.db
        .select({
          id: invAiInsights.id,
          insightType: invAiInsights.insightType,
          severity: invAiInsights.severity,
          status: invAiInsights.status,
          title: invAiInsights.title,
          body: invAiInsights.body,
          sourceRefs: invAiInsights.sourceRefs,
          warehouseId: invAiInsights.warehouseId,
          windowDays: invAiInsights.windowDays,
          evidenceHash: invAiInsights.evidenceHash,
          acknowledgedBy: invAiInsights.acknowledgedBy,
          acknowledgedAt: invAiInsights.acknowledgedAt,
          resolutionNote: invAiInsights.resolutionNote,
          createdAt: invAiInsights.createdAt,
        })
        .from(invAiInsights)
        .where(where)
        .orderBy(desc(invAiInsights.createdAt), desc(invAiInsights.id))
        .limit(filters.limit)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::int` }).from(invAiInsights).where(where),
    ]);

    const total = countRow?.total ?? 0;
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.insightType,
        severity: row.severity,
        status: row.status,
        title: row.title,
        body: row.body,
        warehouseId: row.warehouseId,
        windowDays: row.windowDays,
        evidenceHash: row.evidenceHash,
        evidence: evidenceFrom(row.id, row.sourceRefs),
        detector: toDetectorView(detectorFor(row.insightType)),
        acknowledgedBy: row.acknowledgedBy,
        acknowledgedAt: row.acknowledgedAt,
        resolutionNote: row.resolutionNote,
        createdAt: row.createdAt,
      })),
      total,
      page: filters.page,
      totalPages: Math.ceil(total / filters.limit),
      orgWideSignalsHidden: restricted,
    };
  }

  /**
   * Acknowledge or dismiss one finding.
   *
   * The scope predicate is re-applied on the write, not just on the read that
   * populated the list. A caller who learned an id some other way — a stale tab,
   * a guess, a link from somebody else — must not be able to close somebody
   * else's queue item, and the id-only update is exactly the shape that would
   * let them.
   *
   * `NotFoundException` on a miss, including a miss caused by scope: §4's
   * existence-oracle rule. The caller finds out that this id is not theirs to
   * act on, and nothing more.
   *
   * The affected-row count is checked rather than assumed. An update that
   * matched nothing is a denial, and returning the row we hoped to write would
   * report success for a write that never happened.
   */
  async review(
    user: CurrentUserContext,
    insightId: number,
    body: ReviewAnomalyInput,
  ): Promise<InvAnomalyRow> {
    const { orgId, userId } = user;
    const scope = await this.warehouseScope.resolve(orgId, userId);

    const status = body.action === "acknowledge" ? "ACKNOWLEDGED" : "DISMISSED";
    const reviewedAt = new Date();

    const [updated] = await this.db
      .update(invAiInsights)
      .set({
        status,
        acknowledgedBy: userId,
        acknowledgedAt: reviewedAt,
        resolutionNote: body.note ?? null,
      })
      .where(
        and(
          eq(invAiInsights.id, insightId),
          eq(invAiInsights.orgId, orgId),
          anomalyVisibilityPredicate(scope),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException("Not found");

    await this.cache.invalidate(CACHE_KEYS.invAiInsightsList(orgId));

    return {
      id: updated.id,
      type: updated.insightType,
      severity: updated.severity,
      status: updated.status,
      title: updated.title,
      body: updated.body,
      warehouseId: updated.warehouseId,
      windowDays: updated.windowDays,
      evidenceHash: updated.evidenceHash,
      evidence: evidenceFrom(updated.id, updated.sourceRefs),
      detector: toDetectorView(detectorFor(updated.insightType)),
      acknowledgedBy: updated.acknowledgedBy,
      acknowledgedAt: updated.acknowledgedAt,
      resolutionNote: updated.resolutionNote,
      createdAt: updated.createdAt,
    };
  }
}
