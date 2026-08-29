import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  invGrns,
  invLandedCostAllocations,
  invLandedCostCharges,
  invLandedCostVouchers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { centsToDecimal } from "./lib/apportion";
import type {
  AddLandedCostChargeInput,
  CreateLandedCostVoucherInput,
  ListLandedCostVouchersInput,
} from "./dto/landed-cost.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * G5 — the landed-cost document, before any money moves.
 *
 * Split from `LandedCostApplyService` for the reason receiving is split from
 * posting: raising a voucher, adding a carrier's invoice to it and reading it
 * back touch no cost layer and no general ledger, so "has this changed what
 * stock is worth" is answerable by reading one import. Everything that revalues
 * anything lives in the other file.
 *
 * A voucher hangs off a goods receipt rather than a purchase order because
 * freight is charged on what physically arrived. A purchase order for a thousand
 * units delivered in four shipments has four freight bills, and apportioning any
 * of them across the order rather than the delivery would put cost on units that
 * are still at the supplier.
 */
@Injectable()
export class LandedCostService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sequences: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * Raises a voucher against a receipt, with at least one charge on it.
   *
   * Idempotent on the caller's key: a voucher is a financial document, and a
   * retried request that raises a second one puts the freight through twice the
   * moment somebody applies both.
   */
  async createVoucher(
    orgId: string,
    userId: string,
    input: CreateLandedCostVoucherInput,
    idempotencyKey: string,
  ): Promise<{ id: number; voucherNumber: string }> {
    const grn = await this.assertReceiptVisible(orgId, userId, input.grnId);

    const created = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.landed-cost.create", grnId: input.grnId },
        () => this.insertVoucher(tx, orgId, userId, input, grn.grnNumber),
        // Read field by field rather than through `revivedId`, which unwraps a
        // scalar result and would see this object as NaN — so a retried create
        // would answer 409 "unreadable" instead of replaying the voucher it
        // already raised. The stored response has been through JSONB, so nothing
        // here assumes a type it has not checked.
        (stored) => {
          const revived = stored as { id?: unknown; voucherNumber?: unknown };
          const id = Number(revived.id);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return { id, voucherNumber: String(revived.voucherNumber ?? "") };
        },
      ),
    );

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "landed-cost.create",
      resourceType: "inv_landed_cost_voucher",
      resourceId: String(created.id),
      after: { status: "DRAFT", grnId: input.grnId, chargeCount: input.charges.length },
    });

    return created;
  }

  private async insertVoucher(
    tx: Tx,
    orgId: string,
    userId: string,
    input: CreateLandedCostVoucherInput,
    grnNumber: string,
  ): Promise<{ id: number; voucherNumber: string }> {
    const voucherNumber = await this.sequences.next(orgId, "LANDED_COST", tx);

    // Summed as BigInt. Every charge is integer minor units, so the total is
    // exact and there is no point in the pipeline where it becomes a float.
    const chargeTotalCents = input.charges.reduce(
      (sum, charge) => sum + BigInt(charge.amountCents),
      0n,
    );

    const [voucher] = await tx
      .insert(invLandedCostVouchers)
      .values({
        orgId,
        grnId: input.grnId,
        voucherNumber,
        status: "DRAFT",
        allocationBasis: input.allocationBasis,
        currency: input.currency,
        chargeTotalCents,
        notes: input.notes ?? `Landed cost for ${grnNumber}`,
        createdBy: userId,
      })
      .returning({ id: invLandedCostVouchers.id });

    if (!voucher) throw new ConflictException("The landed-cost voucher could not be raised");

    await tx.insert(invLandedCostCharges).values(
      input.charges.map((charge) => ({
        orgId,
        voucherId: voucher.id,
        chargeType: charge.chargeType,
        description: charge.description,
        amountCents: BigInt(charge.amountCents),
        vendorId: charge.vendorId ?? null,
        reference: charge.reference ?? null,
      })),
    );

    return { id: voucher.id, voucherNumber };
  }

  /**
   * Adds a charge to a voucher that has not been applied.
   *
   * The status is checked under a row lock and the header total is moved in the
   * same statement that inserts the line, so two carriers' invoices arriving at
   * once cannot leave the header disagreeing with its own charges.
   */
  async addCharge(
    orgId: string,
    userId: string,
    voucherId: number,
    input: AddLandedCostChargeInput,
  ): Promise<{ voucherId: number; chargeTotalCents: string }> {
    await this.assertVoucherVisible(orgId, userId, voucherId);

    return this.db.transaction(async (tx) => {
      const voucher = await this.lockVoucher(tx, orgId, voucherId);
      if (voucher.status !== "DRAFT") {
        throw new ConflictException(
          "This landed-cost voucher has already been applied; raise another for a later charge",
        );
      }

      await tx.insert(invLandedCostCharges).values({
        orgId,
        voucherId,
        chargeType: input.chargeType,
        description: input.description,
        amountCents: BigInt(input.amountCents),
        vendorId: input.vendorId ?? null,
        reference: input.reference ?? null,
      });

      const [updated] = await tx
        .update(invLandedCostVouchers)
        .set({
          chargeTotalCents: sql`${invLandedCostVouchers.chargeTotalCents} + ${input.amountCents}::bigint`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(invLandedCostVouchers.orgId, orgId), eq(invLandedCostVouchers.id, voucherId)),
        )
        .returning({ total: invLandedCostVouchers.chargeTotalCents });

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "landed-cost.charge.add",
        resourceType: "inv_landed_cost_voucher",
        resourceId: String(voucherId),
        metadata: { chargeType: input.chargeType, amountCents: input.amountCents },
      });

      return { voucherId, chargeTotalCents: String(updated?.total ?? 0n) };
    });
  }

  /**
   * Abandons a voucher nobody has applied. Physical delete rather than a
   * `deleted_at`, and deliberately: an unapplied voucher moved no money and
   * carries no retention duty, which is the exception §3 names. An APPLIED one
   * can never be deleted — it is the explanation for a cost layer's value.
   */
  async deleteVoucher(orgId: string, userId: string, voucherId: number): Promise<{ deleted: true }> {
    await this.assertVoucherVisible(orgId, userId, voucherId);

    return this.db.transaction(async (tx) => {
      const voucher = await this.lockVoucher(tx, orgId, voucherId);
      if (voucher.status !== "DRAFT") {
        throw new ConflictException(
          "An applied landed-cost voucher cannot be deleted; it is the record of what a cost layer absorbed",
        );
      }

      await tx
        .delete(invLandedCostVouchers)
        .where(
          and(eq(invLandedCostVouchers.orgId, orgId), eq(invLandedCostVouchers.id, voucherId)),
        );

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "landed-cost.delete",
        resourceType: "inv_landed_cost_voucher",
        resourceId: String(voucherId),
        before: { status: "DRAFT" },
      });

      return { deleted: true as const };
    });
  }

  async listVouchers(orgId: string, userId: string, filters: ListLandedCostVouchersInput) {
    const { grnId, status, page, limit } = filters;
    const offset = (page - 1) * limit;

    // Warehouse scope through the receipt the voucher hangs off: a clerk who
    // cannot see a delivery must not see what it cost to land it either.
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const conditions = [eq(invLandedCostVouchers.orgId, orgId)];
    if (grnId) conditions.push(eq(invLandedCostVouchers.grnId, grnId));
    if (status) conditions.push(eq(invLandedCostVouchers.status, status));

    const scoped = and(
      ...conditions,
      sql`EXISTS (
        SELECT 1 FROM inv_grns g
        WHERE g.id = ${invLandedCostVouchers.grnId}
          AND g.org_id = ${orgId}
          AND ${scope.location(sql`g.location_id`)}
      )`,
    );

    const [items, counted] = await Promise.all([
      this.db
        .select({
          id: invLandedCostVouchers.id,
          voucherNumber: invLandedCostVouchers.voucherNumber,
          grnId: invLandedCostVouchers.grnId,
          status: invLandedCostVouchers.status,
          allocationBasis: invLandedCostVouchers.allocationBasis,
          currency: invLandedCostVouchers.currency,
          chargeTotalCents: invLandedCostVouchers.chargeTotalCents,
          capitalisedValue: invLandedCostVouchers.capitalisedValue,
          expensedValue: invLandedCostVouchers.expensedValue,
          appliedAt: invLandedCostVouchers.appliedAt,
          createdAt: invLandedCostVouchers.createdAt,
        })
        .from(invLandedCostVouchers)
        .where(scoped)
        .orderBy(desc(invLandedCostVouchers.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invLandedCostVouchers)
        .where(scoped),
    ]);

    const total = counted[0]?.count ?? 0;
    return {
      items: items.map((item) => ({ ...item, chargeTotalCents: String(item.chargeTotalCents) })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** One voucher with its charges and, once applied, where every fraction went. */
  async getVoucher(orgId: string, userId: string, voucherId: number) {
    const voucher = await this.db.query.invLandedCostVouchers.findFirst({
      where: and(
        eq(invLandedCostVouchers.orgId, orgId),
        eq(invLandedCostVouchers.id, voucherId),
      ),
      columns: {
        id: true,
        voucherNumber: true,
        grnId: true,
        status: true,
        allocationBasis: true,
        currency: true,
        chargeTotalCents: true,
        capitalisedValue: true,
        expensedValue: true,
        notes: true,
        appliedAt: true,
        createdAt: true,
      },
    });
    if (!voucher) throw new NotFoundException("Landed-cost voucher not found");

    await this.assertReceiptVisible(orgId, userId, voucher.grnId);

    const [charges, allocations] = await Promise.all([
      this.db
        .select({
          id: invLandedCostCharges.id,
          chargeType: invLandedCostCharges.chargeType,
          description: invLandedCostCharges.description,
          amountCents: invLandedCostCharges.amountCents,
          vendorId: invLandedCostCharges.vendorId,
          reference: invLandedCostCharges.reference,
        })
        .from(invLandedCostCharges)
        .where(
          and(
            eq(invLandedCostCharges.orgId, orgId),
            eq(invLandedCostCharges.voucherId, voucherId),
          ),
        )
        .orderBy(invLandedCostCharges.id),
      this.db
        .select({
          valuationLayerId: invLandedCostAllocations.valuationLayerId,
          productVariantId: invLandedCostAllocations.productVariantId,
          costingMethod: invLandedCostAllocations.costingMethod,
          weight: invLandedCostAllocations.weight,
          allocatedValue: invLandedCostAllocations.allocatedValue,
          capitalisedValue: invLandedCostAllocations.capitalisedValue,
          expensedValue: invLandedCostAllocations.expensedValue,
          layerQuantity: invLandedCostAllocations.layerQuantity,
          remainingQuantity: invLandedCostAllocations.remainingQuantity,
          unitCostBefore: invLandedCostAllocations.unitCostBefore,
          unitCostAfter: invLandedCostAllocations.unitCostAfter,
        })
        .from(invLandedCostAllocations)
        .where(
          and(
            eq(invLandedCostAllocations.orgId, orgId),
            eq(invLandedCostAllocations.voucherId, voucherId),
          ),
        )
        .orderBy(invLandedCostAllocations.valuationLayerId),
    ]);

    return {
      ...voucher,
      chargeTotalCents: String(voucher.chargeTotalCents),
      /** The same total at the grain the cost layers are kept in. */
      chargeTotal: centsToDecimal(voucher.chargeTotalCents),
      charges: charges.map((charge) => ({ ...charge, amountCents: String(charge.amountCents) })),
      allocations,
    };
  }

  /**
   * The receipt, re-asserted against the caller's warehouse scope.
   *
   * A voucher takes a `grnId` from the client, so this is the object-level check
   * §4 requires on every id-taking route. A receipt in another organisation, or
   * in a warehouse this person cannot see, answers 404 rather than 403 — a 403
   * would confirm the receipt exists and turn the route into an existence
   * oracle.
   */
  private async assertReceiptVisible(
    orgId: string,
    userId: string,
    grnId: number,
  ): Promise<{ id: number; grnNumber: string; status: string; locationId: number | null }> {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      columns: { id: true, grnNumber: true, status: true, locationId: true },
    });
    if (!grn) throw new NotFoundException("Goods receipt not found");
    if (grn.status === "CANCELLED")
      throw new BadRequestException("A cancelled goods receipt has no cost to land");
    await this.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);
    return grn;
  }

  /**
   * The same object-level check, reached through the voucher rather than the
   * receipt — every route that takes a `voucherId` from the client goes through
   * here before it reads or writes anything (§4).
   */
  private async assertVoucherVisible(
    orgId: string,
    userId: string,
    voucherId: number,
  ): Promise<void> {
    const voucher = await this.db.query.invLandedCostVouchers.findFirst({
      where: and(
        eq(invLandedCostVouchers.orgId, orgId),
        eq(invLandedCostVouchers.id, voucherId),
      ),
      columns: { grnId: true },
    });
    if (!voucher) throw new NotFoundException("Landed-cost voucher not found");
    await this.assertReceiptVisible(orgId, userId, voucher.grnId);
  }

  private async lockVoucher(
    tx: Tx,
    orgId: string,
    voucherId: number,
  ): Promise<{ status: string; grn_id: number }> {
    const [locked] = await tx.execute<{ status: string; grn_id: number }>(sql`
      SELECT status, grn_id FROM inv_landed_cost_vouchers
      WHERE id = ${voucherId} AND org_id = ${orgId}
      FOR UPDATE`);
    if (!locked) throw new NotFoundException("Landed-cost voucher not found");
    return locked;
  }
}
