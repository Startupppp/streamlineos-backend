import { and, eq } from "drizzle-orm";
import type { Logger } from "@nestjs/common";
import {
  invProductVariants,
  invShipmentLines,
  invSoLines,
} from "../../../../db/schema";
import { mulDec } from "../../stock-engine/decimal";
import type { InvSettingsRow } from "../../stock-engine/stock-engine.types";
import type { ShipSoResult } from "../so-ship";
import type { Db } from "../../../../db/drizzle.module";
import type { IndiaComplianceService } from "../../compliance/india-compliance.service";

/**
 * Filing a shipped sales order's statutory documents, lifted out of
 * `so-fulfillment.service.ts` unchanged. Both were private with no caller
 * outside it, and both are fire-after-ship work rather than part of the
 * shipment transaction.
 */
export interface FilingDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly compliance: IndiaComplianceService;
}

  /**
   * E5 — the shipment seam: a dispatched shipment stores an IRN and emits the
   * event, when the flags say so.
   *
   * ## Off means nothing happens
   *
   * The flags come from the settings row `shipSo` has already loaded, so an
   * organisation with e-invoicing off pays for no extra query, constructs no
   * payload and reaches no adapter. `IndiaComplianceService.register` refuses a
   * second time on the same flags — this early return is not the boundary, it is
   * what makes "flag off" cost nothing.
   *
   * ## The ledger is untouched either way
   *
   * Everything below runs after the ship transaction has committed and calls
   * only `IndiaComplianceService`, which imports no stock engine. A shipment
   * posted with the flags on and the same shipment posted with them off produce
   * identical `inv_stock_transactions` rows; `__tests__/so-ship-compliance.spec.ts`
   * asserts exactly that.
   *
   * ## What a replay does
   *
   * Nothing new. `register` hashes the document and returns the existing IRN for
   * an unchanged one, so a retried ship — which replays through the idempotency
   * claim and reaches here again — files once.
   */
export async function fileStatutoryDocuments(
    deps: FilingDeps,
    orgId: string,
    userId: string,
    soId: number,
    result: ShipSoResult,
    settings: InvSettingsRow,
  ): Promise<void> {
    // The `gst` pack is a prerequisite: without it no line carries an HSN code,
    // and a line with no HSN cannot be described to a tax authority at all.
    if (!settings.packs.gst) return;
    if (!settings.gstEinvoiceEnabled && !settings.gstEwaybillEnabled) return;
    if (!result.shipmentId) return;

    try {
      const lines = await deps.db
        .select({
          name: invProductVariants.name,
          sku: invProductVariants.sku,
          hsnCode: invSoLines.hsnCode,
          quantity: invShipmentLines.quantity,
          unitPrice: invSoLines.unitPrice,
        })
        .from(invShipmentLines)
        .innerJoin(
          invProductVariants,
          and(
            eq(invProductVariants.id, invShipmentLines.productVariantId),
            eq(invProductVariants.orgId, invShipmentLines.orgId),
          ),
        )
        .leftJoin(
          invSoLines,
          and(
            eq(invSoLines.id, invShipmentLines.soLineId),
            eq(invSoLines.orgId, invShipmentLines.orgId),
          ),
        )
        .where(
          and(
            eq(invShipmentLines.orgId, orgId),
            eq(invShipmentLines.shipmentId, result.shipmentId),
          ),
        );

      if (lines.length === 0) return;

      const complianceLines = lines.map((line) => ({
        description: `${line.sku} ${line.name}`.trim(),
        hsnCode: line.hsnCode,
        // Decimal strings the whole way. A quantity or a taxable value that
        // becomes a float on its way to a tax authority is a defect, not a
        // rounding preference.
        quantity: line.quantity,
        taxableValue: mulDec(line.quantity, line.unitPrice ?? "0"),
      }));

      // Two documents, two calls, each gated on its own flag. An organisation
      // that files e-invoices and hands e-way bills to its transporter is
      // ordinary, and folding the two into one call would make that
      // unrepresentable.
      if (settings.gstEinvoiceEnabled) {
        await fileOne(deps, orgId, userId, soId, result, "EINVOICE", complianceLines);
      }
      if (settings.gstEwaybillEnabled) {
        await fileOne(deps, orgId, userId, soId, result, "EWAYBILL", complianceLines);
      }
    } catch (error: unknown) {
      // Reported, never silent (§4). This cannot roll anything back — the goods
      // have left and the ledger is right — but an operator has to be able to
      // find out that a filing did not happen, and the compliance row itself
      // records a FAILED attempt whenever the adapter answered at all.
      deps.logger.error(
        `Statutory filing for shipment ${result.shipmentId} (SO ${soId}) failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

export async function fileOne(
    deps: FilingDeps,
    orgId: string,
    userId: string,
    soId: number,
    result: ShipSoResult,
    kind: "EINVOICE" | "EWAYBILL",
    lines: Array<{ description: string; hsnCode: string | null; quantity: string; taxableValue: string }>,
  ): Promise<void> {
    const filed = await deps.compliance.register(orgId, userId, {
      kind,
      // The shipment, not the order: an e-way bill describes goods on a vehicle,
      // and a partially shipped order raises one document per dispatch rather
      // than one for the order.
      sourceType: "inv_shipment",
      sourceId: String(result.shipmentId),
      documentNumber: result.shipmentNumber,
      lines,
    });

    if (filed.status === "FAILED") {
      deps.logger.warn(
        `${kind} for shipment ${result.shipmentId} (SO ${soId}) was refused: ${filed.code} ${filed.message}`,
      );
    }
  }
