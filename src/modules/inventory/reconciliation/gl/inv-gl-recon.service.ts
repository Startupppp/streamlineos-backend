import { Inject, Injectable } from "@nestjs/common";
import { type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { InventoryAccountingBridge } from "../../stock-engine/accounting-bridge";
import { InventoryPeriodService } from "../../valuation/inventory-period.service";
import { resolveGlPostingRules, type GlReconStatus } from "./gl-posting-rules";
import {
  glOrphanJournalsSql,
  glReconRowsSql,
  glReconSummarySql,
  glUnpostedByDesignSql,
} from "./lib/gl-recon-sql";
import type { GlReconQueryInput } from "./dto/gl-recon.schemas";

export interface GlReconRow {
  sourceType: string;
  sourceId: string;
  label: string;
  sourceEvent: string;
  postedOn: string;
  movementValue: string;
  netQuantity: string;
  movementCount: number;
  hasCost: boolean;
  accountCodes: string[];
  /**
   * The roles (gl system tags) this entry names that no account in the
   * organisation's book fills. A role with no account has no code to list, so
   * the field keeps its name for the report's consumers and carries the tag,
   * which is the thing the operator has to go and assign.
   */
  missingAccountCodes: string[];
  /** The kernel journal's id, a uuid since the accounting rewrite. */
  journalEntryId: string | null;
  journalEntryNumber: string | null;
  journalEntryDate: string | null;
  /** `POSTED` or `REVERSED`; the kernel has no draft journals. */
  journalStatus: string | null;
  /** Debits across the matched journals, in major units at two decimals. */
  journalValue: string | null;
  status: GlReconStatus;
}

interface GlReconRowWithTotal extends GlReconRow, Record<string, unknown> {
  totalRows: number;
}

export interface GlReconSummary extends Record<string, unknown> {
  groups: number;
  matched: number;
  valueMismatch: number;
  missingCoa: number;
  unmatched: number;
  notInstalled: number;
  movementValue: string;
  journalValue: string;
  unreconciledValue: string;
}

interface UncoveredRow extends Record<string, unknown> {
  sourceType: string;
  movementCount: number;
  movementValue: string;
  postedByStockBridge: boolean;
}

interface OrphanRow extends Record<string, unknown> {
  journalEntryId: string;
  journalEntryNumber: string;
  journalEntryDate: string;
  sourceType: string;
  sourceId: string | null;
  sourceEvent: string | null;
  journalStatus: string;
  journalValue: string;
}

const ORPHAN_LIMIT = 50;

/**
 * D6 — inventory movements against the journals the accounting kernel holds for
 * them, for one period.
 *
 * This report reads. It never posts: inventory reaches the general ledger only
 * through `PostingCommandService`, and a reconciliation that repaired what it
 * found would be marking its own homework. What it can do is name the gap
 * precisely enough to fix. A `MISSING_COA` row carries the roles the book has
 * no account for, and that is the whole remedy.
 *
 * It covers the documents inventory posts itself: receipts, shipments and
 * landed cost. The document kinds `StockMovementBridgeService` posts are
 * reconciled by the accounting module's unposted-movements report. This report
 * lists them as `postedByStockBridge` and does not run a second reconciliation
 * of them.
 */
@Injectable()
export class InvGlReconService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly periods: InventoryPeriodService,
    private readonly bridge: InventoryAccountingBridge,
  ) {}

  async report(orgId: string, userId: string, query: GlReconQueryInput) {
    const { page, limit, warehouseId, status } = query;
    const window = await this.periods.resolveWindow(orgId, query);
    const bookId = await this.bridge.defaultBookId(orgId);
    const journalsInstalled = bookId !== null;
    /**
     * INV-09 — resolved once, through the bridge, from the same system tags the
     * posting path resolves. If the report read the chart any other way, the
     * first organisation to re-tag its inventory account would see every goods
     * receipt reported against an account it never posted to.
     */
    const rules = resolveGlPostingRules(await this.bridge.resolveAccountCodes(orgId));
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const locationScope = (column: string): SQL =>
      this.warehouseScope.locationPredicate(scope, column);

    const base = {
      orgId,
      fromDate: window.fromDate,
      toDate: window.toDate,
      locationScope,
      warehouseId,
      bookId,
      rules,
    };

    const [rows, summaryRows, uncovered, orphans] = await Promise.all([
      this.db.execute<GlReconRowWithTotal>(
        glReconRowsSql({ ...base, status, limit, offset: (page - 1) * limit }),
      ),
      this.db.execute<GlReconSummary>(glReconSummarySql(base)),
      this.db.execute<UncoveredRow>(glUnpostedByDesignSql(base)),
      bookId === null
        ? Promise.resolve([] as OrphanRow[])
        : this.db.execute<OrphanRow>(
            glOrphanJournalsSql({
              orgId,
              bookId,
              fromDate: window.fromDate,
              toDate: window.toDate,
              limit: ORPHAN_LIMIT,
            }),
          ),
    ]);

    const total = rows[0]?.totalRows ?? 0;
    const summary = summaryRows[0] ?? emptySummary();
    const withoutFlag = ({ postedByStockBridge: _flag, ...row }: UncoveredRow) => row;
    const unpostedByDesign = uncovered.filter((row) => !row.postedByStockBridge).map(withoutFlag);
    const postedByStockBridge = uncovered.filter((row) => row.postedByStockBridge).map(withoutFlag);

    return {
      generatedAt: new Date().toISOString(),
      window: {
        fromDate: window.fromDate,
        toDate: window.toDate,
        period: window.period,
      },
      accounting: {
        /** Whether this organisation keeps books; the name predates the kernel. */
        journalsInstalled,
        /**
         * Said out loud rather than implied by a row of zeroes. A tenant that
         * has not enabled accounting has no gap to close, and a report that
         * looked identical to one whose postings are all failing would be worse
         * than no report.
         */
        note: !journalsInstalled
          ? "Accounting is not enabled for this organisation, so no inventory movement is expected to produce a journal entry."
          : postedByStockBridge.length > 0
            ? "Adjustments, transfers, counts, quality write-offs and returns are posted by the accounting module's stock bridge, not by a rule in this report. Reconcile them in Accounting, under Reconciliation, unposted movements."
            : null,
      },
      rules,
      summary,
      unpostedByDesign,
      postedByStockBridge,
      orphanJournals: orphans,
      items: rows.map(({ totalRows: _t, ...row }) => row),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  listPeriods(orgId: string) {
    return this.periods.listPeriods(orgId);
  }
}

function emptySummary(): GlReconSummary {
  return {
    groups: 0,
    matched: 0,
    valueMismatch: 0,
    missingCoa: 0,
    unmatched: 0,
    notInstalled: 0,
    movementValue: "0",
    journalValue: "0",
    unreconciledValue: "0",
  };
}
