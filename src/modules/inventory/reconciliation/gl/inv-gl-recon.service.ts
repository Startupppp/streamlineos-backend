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
  missingAccountCodes: string[];
  journalEntryId: number | null;
  journalEntryNumber: string | null;
  journalEntryDate: string | null;
  journalStatus: string | null;
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

interface UnpostedRow extends Record<string, unknown> {
  sourceType: string;
  movementCount: number;
  movementValue: string;
}

interface OrphanRow extends Record<string, unknown> {
  journalEntryId: number;
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
 * D6 — inventory movements against the journals the accounting bridge posted
 * for them, for one period.
 *
 * This report reads. It never posts: inventory reaches the general ledger only
 * through `JournalPostingService`, called from the three write paths, and a
 * reconciliation that repaired what it found would be marking its own homework.
 * What it can do is name the gap precisely enough to fix — a `MISSING_COA` row
 * carries the account codes the tenant has not created, which is the whole
 * remedy.
 *
 * Every figure is `numeric` in Postgres and `text` on the wire. Comparing a
 * ledger against a journal is the one place a float would be indefensible: two
 * amounts that differ in the fifteenth decimal place are equal in every sense
 * that matters to an accountant and unequal to `===`.
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
    const journalsInstalled = await this.bridge.hasJournals();
    /**
     * INV-09 — resolved once, through the bridge, which is the same call the
     * posting path makes.
     *
     * Not a convenience: if the report resolved independently of posting, or
     * kept the literals it used to, then the first organisation to map
     * INVENTORY_ASSET somewhere else would see every goods receipt reported as
     * MISSING_COA against an account it never posted to. The report and the
     * ledger have to be looking at the same chart.
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
      journalsInstalled,
      rules,
    };

    const [rows, summaryRows, unposted, orphans] = await Promise.all([
      this.db.execute<GlReconRowWithTotal>(
        glReconRowsSql({ ...base, status, limit, offset: (page - 1) * limit }),
      ),
      this.db.execute<GlReconSummary>(glReconSummarySql(base)),
      this.db.execute<UnpostedRow>(glUnpostedByDesignSql(base)),
      journalsInstalled
        ? this.db.execute<OrphanRow>(
            glOrphanJournalsSql({
              orgId,
              fromDate: window.fromDate,
              toDate: window.toDate,
              limit: ORPHAN_LIMIT,
            }),
          )
        : Promise.resolve([] as OrphanRow[]),
    ]);

    const total = rows[0]?.totalRows ?? 0;
    const summary = summaryRows[0] ?? emptySummary();

    return {
      generatedAt: new Date().toISOString(),
      window: {
        fromDate: window.fromDate,
        toDate: window.toDate,
        period: window.period,
      },
      accounting: {
        journalsInstalled,
        /**
         * Said out loud rather than implied by a row of zeroes. A tenant that
         * has not bought accounting has no gap to close, and a report that
         * looked identical to one whose postings are all failing would be worse
         * than no report.
         */
        note: journalsInstalled
          ? null
          : "The accounting module is not installed in this workspace, so no inventory movement has produced a journal entry.",
      },
      rules,
      summary,
      unpostedByDesign: unposted,
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
