import { Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../kernel/sequence.service";
import { PostingCommandService } from "./posting-command.service";
import { AdapterRejection, type PostingCommandLine } from "./posting-command.types";
import { MOVEMENT_GL_TREATMENT, type InvTxnType } from "./stock-movement-treatment";

/**
 * Which document produced the movements. It becomes the posting purpose, so
 * `stock_move:{id}:{kind}` is the idempotency key.
 *
 * It is a closed set rather than a free string for the reason the ADR records
 * about legacy invoices: two writers into one id space that chose different
 * purposes made a double-post reachable. Every document kind here writes under
 * exactly one purpose, and the ids come from different tables, so no two
 * documents can share a key.
 */
export type StockDocumentKind =
  | "adjustment"
  | "cycle_count"
  | "physical_audit"
  | "quality_inspection"
  | "customer_return"
  | "vendor_return"
  | "transfer";

export interface StockMovementPosting {
  kind: StockDocumentKind;
  /** The document's own id, as it appears in `inv_stock_transactions.reference_id`. */
  documentId: string;
  /** Ids the stock engine just returned. The journal is built from these rows. */
  transactionIds: number[];
  journalDate: string;
  memo: string;
}

interface MovementRow {
  transaction_type: InvTxnType;
  signed_minor: string;
}

@Injectable()
export class StockMovementBridgeService {
  private readonly logger = new Logger(StockMovementBridgeService.name);

  constructor(private readonly posting: PostingCommandService) {}

  /**
   * Post the general-ledger effect of stock movements that have just been
   * written, on the same transaction that wrote them.
   *
   * **The value comes from the stock ledger, never from the caller.** Every
   * other design has each call site recompute what it thinks the movement was
   * worth — which is how a bridge drifts from the warehouse it is supposed to
   * value, and precisely what ACC-09's reconciliation exists to detect. Reading
   * the rows the engine just wrote makes the two agree by construction, so that
   * report can only ever fire on a real defect.
   *
   * Movements whose treatment is `none` are skipped deliberately, and a
   * document made up entirely of them posts nothing at all. That is not the
   * same as failing to post: a quarantine does not change what the business
   * owns, and a journal for it would be wrong rather than merely noisy.
   *
   * Fails closed, with one exception. A missing account role, a locked period
   * or an unbalanced journal all refuse the movement outright, because a stock
   * change the ledger will not accept must not happen. `BOOK_NOT_ENABLED` is
   * the exception: accounting is opt-in and an org without it must be able to
   * run its warehouse.
   */
  async post(
    orgId: string,
    userId: string | null,
    input: StockMovementPosting,
    tx: DbOrTx,
  ): Promise<void> {
    if (input.transactionIds.length === 0) return;

    const lines = await this.linesFor(orgId, input.transactionIds, tx);
    if (lines.length === 0) return;

    try {
      await this.posting.submit(
        orgId,
        userId,
        {
          sourceType: "stock_move",
          sourceId: input.documentId,
          purpose: input.kind,
          journalDate: input.journalDate,
          memo: input.memo,
          lines,
        },
        tx,
      );
    } catch (error) {
      if (error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED") {
        this.logger.debug(
          `Accounting is not enabled for org ${orgId}; ${input.kind} ${input.documentId} was not posted`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * One balanced pair per counterpart role.
   *
   * Grouping by role rather than emitting a pair per movement keeps a
   * thousand-line stock count to two journal lines, and nets a transfer's two
   * legs against each other — which is what makes a complete transfer post
   * nothing and an incomplete one post exactly its shrinkage, with no special
   * case anywhere for transfers.
   */
  private async linesFor(
    orgId: string,
    transactionIds: number[],
    tx: DbOrTx,
  ): Promise<PostingCommandLine[]> {
    /*
      `sign(quantity_change)` supplies the direction because `total_cost` does
      not: an outflow records a positive magnitude (see ACC-09's fix). Rows
      still awaiting a cost, which inventory writes as NULL, contribute nothing
      rather than zero — a movement with no cost is not a movement worth zero.
    */
    const rows = (await tx.execute(sql`
      SELECT t.transaction_type,
             COALESCE(SUM(round(t.total_cost * 100) * sign(t.quantity_change)), 0)::bigint AS signed_minor
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.id IN (${sql.join(
          transactionIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND t.total_cost IS NOT NULL
      GROUP BY t.transaction_type
    `)) as unknown as MovementRow[];

    const byRole = new Map<string, number>();
    for (const row of rows) {
      const treatment = MOVEMENT_GL_TREATMENT[row.transaction_type];
      if (!treatment || treatment.kind === "none") continue;
      const minor = Number(row.signed_minor);
      byRole.set(treatment.role, (byRole.get(treatment.role) ?? 0) + minor);
    }

    const lines: PostingCommandLine[] = [];
    for (const [role, net] of byRole) {
      if (net === 0) continue;
      const magnitude = Math.abs(net);
      const inventoryDebited = net > 0;

      lines.push({
        accountTag: "inventory",
        ...(inventoryDebited ? { debitMinor: magnitude } : { creditMinor: magnitude }),
        description: inventoryDebited ? "Stock increase" : "Stock decrease",
      });
      lines.push({
        accountTag: role as PostingCommandLine["accountTag"],
        ...(inventoryDebited ? { creditMinor: magnitude } : { debitMinor: magnitude }),
        description: `Counterpart (${role})`,
      });
    }

    return lines;
  }
}
