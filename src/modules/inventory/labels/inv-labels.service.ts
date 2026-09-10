import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import QRCode from "qrcode";
import {
  invLocations,
  invProducts,
  invUom,
  invWarehouses,
  organizations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InvBarcodeService } from "../barcode/inv-barcode.service";
import { GrnReadService } from "../purchase-orders/grn-read.service";
import { PoService } from "../purchase-orders/po.service";
import { PickWaveService } from "../picking/pick-wave.service";
import type { LabelPayload } from "../barcode/dto/inv-barcode.schemas";
import { buildGrnNotePdf, type GrnNoteLine } from "./lib/grn-note";
import { buildPickListPdf, type PickListLine } from "./lib/pick-list";

/**
 * G4 — labels and warehouse documents.
 *
 * Its own module rather than an annex of receiving or picking, because printing
 * is the one concern that legitimately spans both and belongs to neither: the
 * same permission (`inventory:labels:print`), the same page furniture, the same
 * question of who may put an organisation's name on a piece of paper.
 *
 * It owns no data. Every figure on every document here comes from the module that
 * owns it — `GrnReadService` and `PoService` for a receipt, `PickWaveService` for
 * a wave, `InvBarcodeService` for a label — through those modules' services and
 * never their tables, so a document cannot drift from the screen it was printed
 * from. The only queries below are for chrome: an organisation's name, a
 * location's code, a unit of measure's abbreviation.
 */
@Injectable()
export class InvLabelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly barcodes: InvBarcodeService,
    private readonly grns: GrnReadService,
    private readonly purchaseOrders: PoService,
    private readonly waves: PickWaveService,
  ) {}

  /**
   * The label payload for one SKU, optionally for one batch of it.
   *
   * Deliberately not a picture. Label stock varies by warehouse, symbology by
   * scanner fleet, and copy count by pallet, so rendering belongs at the printer;
   * what the server owes is the resolved, scannable content and the guarantee
   * that `code` comes back through the lookup endpoint.
   */
  variantLabel(
    orgId: string,
    productVariantId: number,
    lotId?: number,
  ): Promise<LabelPayload> {
    return this.barcodes.buildLabel(orgId, productVariantId, lotId);
  }

  /**
   * The goods received note.
   *
   * The receipt is read through `GrnReadService`, which re-asserts the caller's
   * warehouse scope and answers 404 rather than 403 for a delivery they may not
   * see — so the print route inherits the object-level check instead of
   * reimplementing it. The purchase order is then read without a user, because
   * the authorisation question has already been answered by the receipt this
   * order is the parent of; passing the user again would apply the *order's*
   * warehouse scope and could refuse to print a receipt the caller is
   * demonstrably allowed to read.
   */
  async grnNote(orgId: string, grnId: number, userId: string): Promise<Buffer> {
    const grn = await this.grns.getGrn(orgId, grnId, userId);
    const po = await this.purchaseOrders.getPo(orgId, grn.poId);

    const poLines = new Map(po.lines.map((line) => [line.id, line]));
    const baseUoms = await this.baseUomByProduct(
      orgId,
      po.lines.map((line) => line.productVariant.product.id),
    );

    const lines: GrnNoteLine[] = grn.lines.map((line) => {
      const poLine = poLines.get(line.poLineId);
      const product = poLine?.productVariant.product;
      return {
        sku: poLine?.productVariant.sku ?? product?.sku ?? "-",
        description: product
          ? `${product.name} · ${poLine?.productVariant.name ?? ""}`.trim()
          : "-",
        uom: (product ? baseUoms.get(product.id) : null) ?? "-",
        quantityExpected: line.quantityExpected,
        quantityReceived: line.quantityReceived,
        lotNumber: line.lotNumber,
        expiryDate: line.expiryDate,
        qualityStatus: line.qualityStatus,
        discrepancyReason: line.discrepancyReason,
        serialNumbers: line.serials.map((serial) => serial.serialNumber),
      };
    });

    return buildGrnNotePdf({
      organizationName: await this.organizationName(orgId),
      grnNumber: grn.grnNumber,
      status: grn.status,
      receivedDate: grn.receivedDate,
      locationLabel: await this.locationLabel(orgId, grn.locationId),
      poNumber: po.poNumber,
      vendorName: po.vendor?.name ?? "-",
      vendorCode: po.vendor?.code ?? "-",
      receivedBy: grn.creator?.name ?? "-",
      postedBy: grn.poster?.name ?? null,
      lines,
      stampDataUri: await this.stamp(grn.grnNumber),
    });
  }

  /**
   * The pick list. `getWave` asserts warehouse visibility itself, so the same
   * inheritance applies as for the receipt, and the line order it returns is the
   * pick path — preserved here rather than re-sorted.
   */
  async pickList(orgId: string, pickListId: number, userId: string): Promise<Buffer> {
    const wave = await this.waves.getWave(orgId, userId, pickListId);

    const lines: PickListLine[] = wave.lines.map((line) => ({
      locationCode: line.location_code ?? "-",
      sku: line.sku,
      description: line.variant_name,
      lotNumber: line.lot_number,
      serialNumber: line.serial_number,
      quantityToPick: String(line.quantity_to_pick),
      quantityPicked: String(line.quantity_picked),
      orderNumber: line.so_number,
      exception: line.exception_reason,
    }));

    return buildPickListPdf({
      organizationName: await this.organizationName(orgId),
      pickListNumber: wave.pickNumber,
      status: wave.status,
      warehouseLabel: await this.warehouseLabel(orgId, wave.warehouseId),
      // A name, never the id behind it: a sheet handed to a picker that says
      // `usr_01H9…` names nobody.
      assignedTo: await this.userName(wave.assignedTo),
      createdAt: wave.createdAt.toISOString().slice(0, 10),
      lines,
      stampDataUri: await this.stamp(wave.pickNumber),
    });
  }

  /** The document's own number, scannable, so a sheet on a desk resolves. */
  private stamp(reference: string): Promise<string> {
    return QRCode.toDataURL(reference, { margin: 1, width: 256 });
  }

  /**
   * A person's display name.
   *
   * Explicitly projected rather than read through a relation: the global `users`
   * table still holds authentication secrets and legacy payroll columns, and §3
   * bans an unprojected relation to it outright.
   */
  private async userName(userId: string | null): Promise<string> {
    if (!userId) return "Unassigned";
    const [row] = await this.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.name ?? "Unassigned";
  }

  private async organizationName(orgId: string): Promise<string> {
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organisation not found");
    return org.name;
  }

  private async locationLabel(orgId: string, locationId: number | null): Promise<string> {
    if (locationId === null) return "-";
    const [row] = await this.db
      .select({
        code: invLocations.code,
        name: invLocations.name,
        warehouse: invWarehouses.name,
      })
      .from(invLocations)
      .leftJoin(invWarehouses, eq(invWarehouses.id, invLocations.warehouseId))
      .where(and(eq(invLocations.orgId, orgId), eq(invLocations.id, locationId)))
      .limit(1);
    if (!row) return "-";
    return `${row.warehouse ?? "-"} / ${row.name} (${row.code})`;
  }

  private async warehouseLabel(orgId: string, warehouseId: number | null): Promise<string> {
    if (warehouseId === null) return "All warehouses";
    const [row] = await this.db
      .select({ name: invWarehouses.name, code: invWarehouses.code })
      .from(invWarehouses)
      .where(and(eq(invWarehouses.orgId, orgId), eq(invWarehouses.id, warehouseId)))
      .limit(1);
    return row ? `${row.name} (${row.code})` : "-";
  }

  /**
   * The base unit each product's quantities are held in.
   *
   * `quantity_received` on a receipt line is always in base units — the entered
   * unit and its factor are snapshotted separately — so printing the entered
   * unit's abbreviation beside a base-unit figure would label a quantity of 24
   * eaches as 24 cases.
   */
  /**
   * Scoped by org as well as by id.
   *
   * It filtered on `inArray(invProducts.id, ids)` alone. That was not a live
   * cross-tenant read — `inv_products` and `inv_uom` both carry RLS with a
   * policy, so the app role never saw another org's row, and the ids are
   * derived from a PO already fetched org-scoped. It was still wrong twice
   * over. RLS was the ONLY barrier, so the correctness of this query depended
   * on a table-level setting it never mentions; and §7 is explicit that an
   * RLS-table query which does not supply `org_id` itself cannot use the
   * `(org_id, …)` index, because the policy qual is not leakproof and gets
   * evaluated against heap tuples — the planner refuses the index and the read
   * degrades exactly where a label print fans out over every line of a receipt.
   */
  private async baseUomByProduct(
    orgId: string,
    productIds: readonly number[],
  ): Promise<Map<number, string>> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return new Map();

    const rows = await this.db
      .select({ productId: invProducts.id, abbreviation: invUom.abbreviation })
      .from(invProducts)
      .leftJoin(invUom, and(eq(invUom.id, invProducts.uomId), eq(invUom.orgId, orgId)))
      .where(and(eq(invProducts.orgId, orgId), inArray(invProducts.id, ids)));

    return new Map(
      rows
        .filter((row): row is { productId: number; abbreviation: string } =>
          row.abbreviation !== null,
        )
        .map((row) => [row.productId, row.abbreviation]),
    );
  }
}
