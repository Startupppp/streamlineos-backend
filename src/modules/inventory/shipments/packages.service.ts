import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";
import {
  invPackages,
  invPackageLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService, type ResolvedWarehouseScope } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InvBarcodeService } from "../barcode/inv-barcode.service";
import type {
  ListPackagesQueryInput,
  CreatePackageInput,
  UpdatePackageLinesInput,
  ScanIntoPackageInput,
  ClosePackageInput,
  PackingQueueQueryInput,
} from "./dto/shipments.schemas";
import { CartonizationService } from "./cartonization.service";
import { readPackingQueue } from "./packing-queue";
import { runIdempotent } from "../stock-engine/idempotency";
import { addDec } from "../stock-engine/decimal";
import {
  assertWithinPicked,
  outstandingQuantities,
  packedQuantities,
  pickedQuantities,
  toReconciliationLines,
} from "./packing-reconciliation";
import {
  assertCartonType,
  assertSalesOrderInScope,
  assertShipmentInScope,
  resolveScan,
  resolveSoId,
} from "./lib/package-resolve";

/**
 * B6 — the packing bench.
 *
 * Nothing here posts stock, and that is a rule rather than an omission: the
 * goods left the shelf when the picker took them and leave the building when the
 * shipment is dispatched. A package is a document about where they are in
 * between, and a movement raised here would subtract the same units a second
 * time.
 */
@Injectable()
export class PackagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly cartonization: CartonizationService,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly barcode: InvBarcodeService,
  ) {}

  /**
   * Which packages this caller may see — the list's rule, now the only copy.
   *
   * A package carries no warehouse of its own; its shipment does, and so does
   * the order it is packing, so it is attributable either way and EITHER
   * suffices. OR, not AND: requiring both would hide a carton whose order is in
   * scope purely because its shipment column is still null at the bench.
   *
   * The NULL half falls out of that and differs by table on purpose. `NULL IN
   * (…)` is NULL and `NULL OR NULL` is NULL, so a package anchored to neither
   * document is EXCLUDED from a scoped caller's view — which is exactly what the
   * list has always done. Each detail follows its own aggregate.
   *
   * Private and single so the detail reads cannot drift from the list: this list
   * gained its scope and every read beside it was simply never told, which is
   * the whole defect.
   */
  private packageInScope(orgId: string, scope: ResolvedWarehouseScope): SQL {
    return scope.anyOf(
      sql`${invPackages.shipmentId} IN (SELECT id FROM inv_shipments WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
      sql`${invPackages.soId} IN (SELECT id FROM inv_sales_orders WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
    );
  }

  async list(orgId: string, userId: string, query: ListPackagesQueryInput) {
    const { shipmentId, soId, status, page, limit } = query;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${shipmentId ?? ""}:${soId ?? ""}:${status ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invPackagesNamespace(orgId), `list:${hash}`, async () => {
      const conditions = [
        eq(invPackages.orgId, orgId),
        this.packageInScope(orgId, scope),
      ];
      if (shipmentId) conditions.push(eq(invPackages.shipmentId, shipmentId));
      if (soId) conditions.push(eq(invPackages.soId, soId));
      if (status) conditions.push(eq(invPackages.status, status));
      const where = and(...conditions);

      const [items, [countRow]] = await Promise.all([
        this.db.select().from(invPackages).where(where).orderBy(desc(invPackages.createdAt)).limit(limit).offset(offset),
        this.db.select({ total: sql<number>`count(*)::int` }).from(invPackages).where(where),
      ]);
      const total = countRow?.total ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  /**
   * One package, read by id — and, until now, by anyone in the org.
   *
   * The scope discriminator in the cache key is load-bearing (§6): the predicate
   * below under a scope-free `detail:<id>` key would store one caller's narrowed
   * answer and serve it to the next, defeating the filter in both directions and
   * leaving this worse than the unscoped read it replaces.
   */
  async findOne(orgId: string, userId: string, packageId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.cache.cachedVersioned(CACHE_KEYS.invPackagesNamespace(orgId), `detail:${scope.key}:${packageId}`, async () => {
      const [pkg] = await this.db.select().from(invPackages).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId), this.packageInScope(orgId, scope))).limit(1);
      // 404, never 403 (§4) — a "forbidden" on a package id confirms it exists.
      if (!pkg) throw new NotFoundException("Package not found");
      const lines = await this.db.select().from(invPackageLines).where(eq(invPackageLines.packageId, packageId));
      return { ...pkg, lines };
    }, CACHE_TTL.MEDIUM);
  }

  /**
   * What this package still owes, and what it may not exceed.
   *
   * Read at the bench between scans, so the packer can see the order emptying
   * rather than discovering at close that a carton holds one unit too many.
   */
  async reconciliation(orgId: string, userId: string, packageId: number) {
    const pkg = await this.loadPackage(orgId, userId, packageId);
    const soId = await resolveSoId(this.db, orgId, pkg);
    if (soId === null) {
      return { soId: null, picked: [], packed: [], outstanding: [] };
    }
    const [picked, packed] = await Promise.all([
      pickedQuantities(this.db, orgId, soId),
      packedQuantities(this.db, orgId, soId),
    ]);
    return {
      soId,
      picked: toReconciliationLines(picked),
      packed: toReconciliationLines(packed),
      outstanding: toReconciliationLines(outstandingQuantities(picked, packed)),
    };
  }

  async create(orgId: string, userId: string, input: CreatePackageInput) {
    /*
     * `shipmentId` came straight off the request body and was checked by
     * NOTHING — not the scope, not even the organisation. A carton could be
     * hung off any shipment in the tenant, and it counts: `packedQuantities`
     * reads every package standing for that order, so a carton attached to
     * another warehouse's despatch takes room off the reconciliation the
     * legitimate packer there is measured against, and their next scan is
     * refused for goods they hold in their hand.
     *
     * Measured by the SHIPMENT's own rule — its warehouse column — rather than
     * one invented here, and answered 404 so naming an id you cannot see does
     * not confirm it exists.
     *
     * `soId` is the OTHER arm of the same `anyOf` the list admits a package by,
     * and it stayed on an org-membership check alone — so the same hole was
     * still open through it. Both arms are now measured the same way.
     */
    if (input.shipmentId !== undefined) await assertShipmentInScope(this.db, this.warehouseScope, orgId, userId, input.shipmentId);
    if (input.soId !== undefined) await assertSalesOrderInScope(this.db, this.warehouseScope, orgId, userId, input.soId);
    if (input.cartonTypeId !== undefined) await assertCartonType(this.db, orgId, input.cartonTypeId);

    if (input.soId !== undefined && input.lines.length > 0) {
      const [picked, packed] = await Promise.all([
        pickedQuantities(this.db, orgId, input.soId),
        packedQuantities(this.db, orgId, input.soId),
      ]);
      for (const line of input.lines)
        packed.set(line.productVariantId, addDec(packed.get(line.productVariantId) ?? "0", line.quantity));
      assertWithinPicked(picked, packed);
    }

    const packageNumber = await this.numSeq.next(orgId, "PACKAGE");
    const pkg = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(invPackages).values({
        orgId,
        packageNumber,
        shipmentId: input.shipmentId ?? null,
        soId: input.soId ?? null,
        cartonTypeId: input.cartonTypeId ?? null,
        weight: input.weight ?? null,
        dimensionsL: input.dimensionsL ?? null,
        dimensionsW: input.dimensionsW ?? null,
        dimensionsH: input.dimensionsH ?? null,
        createdBy: userId,
      }).returning();
      if (input.lines.length > 0) {
        await tx.insert(invPackageLines).values(
          input.lines.map((l) => ({
            orgId,
            packageId: row!.id,
            productVariantId: l.productVariantId,
            lotId: l.lotId ?? null,
            serialId: l.serialId ?? null,
            quantity: l.quantity,
          })),
        );
      }
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "package.created",
        resourceType: "package",
        resourceId: String(row!.id),
      });
      return row!;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invPackagesNamespace(orgId));
    return pkg;
  }

  /**
   * B6 — one scan, one unit (or however many the packer keyed).
   *
   * The whole point of scanning into the carton rather than typing a manifest is
   * that the refusal happens at the bench, while the goods are in the packer's
   * hand and the mistake is a second's work to undo. So the reconciliation runs
   * on the way in, against every carton already standing for the order, and a
   * scan that would take the order past what was picked is refused rather than
   * recorded and caught later.
   *
   * The scan is resolved the way picking resolves one: a GS1 payload, a variant
   * barcode, a bare SKU, a lot or a serial label all name goods, and the packer
   * should not have to know which kind of label is on the box.
   *
   * Keyed, and the claim spans the whole command including the guards. A scan is
   * the one request a warehouse makes over a flaky handheld link, and an
   * unkeyed retry of a scan that had already committed records the same physical
   * item twice. Guards inside the claim so a replay returns the stored result
   * rather than the ConflictException its own first run created.
   */
  async scan(
    orgId: string,
    userId: string,
    packageId: number,
    input: ScanIntoPackageInput,
    idempotencyKey: string,
  ) {
    // Outside the transaction because it reads the catalogue and nothing else,
    // and because a payload naming no product should be refused before a claim
    // is taken against it.
    const resolved = await resolveScan(this.barcode, orgId, userId, input);

    // Resolved out here because it reads through the injected db rather than the
    // transaction handle; the predicate it builds is applied to the read INSIDE
    // the claim, so the gate sees the same snapshot the write does and a refusal
    // rolls the claim back with it rather than burning the key.
    const scope = await this.warehouseScope.forUser(orgId, userId);

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.packages.scan", packageId, input },
        async () => {
          const [pkg] = await tx
            .select({ status: invPackages.status, soId: invPackages.soId })
            .from(invPackages)
            .where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId), this.packageInScope(orgId, scope)))
            .limit(1);
          // 404 before the status is ever consulted: a ConflictException on a
          // package the caller may not see would report its state to them.
          if (!pkg) throw new NotFoundException("Package not found");
          if (pkg.status !== "OPEN") throw new ConflictException("Package is not OPEN");
          if (pkg.soId === null) {
            throw new BadRequestException(
              "This package is not packing a sales order, so a scan has nothing to reconcile against",
            );
          }

          // Two packers working one order across two cartons would otherwise
          // both read a total that leaves room and both write into it, and the
          // order goes out with a unit more than anybody picked. Held on the
          // order rather than the package, because that is the grain the
          // reconciliation is computed at.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inv:packing:${orgId}:${pkg.soId}`}, 0))`,
          );

          const [picked, packed] = await Promise.all([
            pickedQuantities(tx, orgId, pkg.soId),
            packedQuantities(tx, orgId, pkg.soId),
          ]);
          packed.set(
            resolved.productVariantId,
            addDec(packed.get(resolved.productVariantId) ?? "0", input.quantity),
          );
          assertWithinPicked(picked, packed);

          // Merged onto the matching grain rather than appended: a carton with
          // twelve rows of one unit each is the same carton as one row of
          // twelve, and only the first makes the manifest unreadable.
          const [existing] = await tx
            .select({ id: invPackageLines.id, quantity: invPackageLines.quantity })
            .from(invPackageLines)
            .where(and(
              eq(invPackageLines.orgId, orgId),
              eq(invPackageLines.packageId, packageId),
              eq(invPackageLines.productVariantId, resolved.productVariantId),
              resolved.lotId === null ? sql`${invPackageLines.lotId} IS NULL` : eq(invPackageLines.lotId, resolved.lotId),
              resolved.serialId === null ? sql`${invPackageLines.serialId} IS NULL` : eq(invPackageLines.serialId, resolved.serialId),
            ))
            .limit(1);

          if (existing) {
            await tx.update(invPackageLines)
              .set({ quantity: addDec(String(existing.quantity), input.quantity) })
              .where(eq(invPackageLines.id, existing.id));
          } else {
            await tx.insert(invPackageLines).values({
              orgId,
              packageId,
              productVariantId: resolved.productVariantId,
              lotId: resolved.lotId,
              serialId: resolved.serialId,
              quantity: input.quantity,
            });
          }

          await this.audit.insert(tx, {
            orgId,
            actorUserId: userId,
            action: "package.scanned",
            resourceType: "package",
            resourceId: String(packageId),
          });

          return { packageId };
        },
        () => ({ packageId }),
      ),
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invPackagesNamespace(orgId));
    return this.reconciliation(orgId, userId, packageId);
  }

  async updateLines(orgId: string, userId: string, packageId: number, input: UpdatePackageLinesInput) {
    const pkg = await this.loadPackage(orgId, userId, packageId);
    if (pkg.status !== "OPEN") throw new ConflictException("Package is not OPEN");

    // The same gate the scan path passes. Without it a client could set any
    // quantity it liked through this route and close the package on it, which
    // is the check being bypassed rather than enforced.
    const soId = await resolveSoId(this.db, orgId, pkg);
    if (soId !== null) {
      const [picked, packed] = await Promise.all([
        pickedQuantities(this.db, orgId, soId),
        packedQuantities(this.db, orgId, soId, packageId),
      ]);
      for (const line of input.lines)
        packed.set(line.productVariantId, addDec(packed.get(line.productVariantId) ?? "0", line.quantity));
      assertWithinPicked(picked, packed);
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(invPackageLines).where(eq(invPackageLines.packageId, packageId));
      await tx.insert(invPackageLines).values(
        input.lines.map((l) => ({
          orgId,
          packageId,
          productVariantId: l.productVariantId,
          lotId: l.lotId ?? null,
          serialId: l.serialId ?? null,
          quantity: l.quantity,
        })),
      );
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "package.lines_updated",
        resourceType: "package",
        resourceId: String(packageId),
      });
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invPackagesNamespace(orgId));
    return this.findOne(orgId, userId, packageId);
  }

  async close(orgId: string, userId: string, packageId: number, input: ClosePackageInput = {}) {
    const pkg = await this.loadPackage(orgId, userId, packageId);
    if (pkg.status !== "OPEN") throw new ConflictException("Package is not OPEN");

    const lines = await this.db.select().from(invPackageLines).where(eq(invPackageLines.packageId, packageId));

    const soId = await resolveSoId(this.db, orgId, pkg);
    if (soId !== null) {
      const [picked, packed] = await Promise.all([
        pickedQuantities(this.db, orgId, soId),
        packedQuantities(this.db, orgId, soId),
      ]);
      assertWithinPicked(picked, packed);
    }

    const cartonTypeId = input.cartonTypeId ?? pkg.cartonTypeId;
    if (input.cartonTypeId !== undefined) await assertCartonType(this.db, orgId, input.cartonTypeId);

    // INV-206. Only when a carton was actually chosen. Refusing to close a
    // package because nobody recorded a carton would stop a warehouse working
    // over a data-entry gap, which is a worse outcome than an unchecked box.
    if (cartonTypeId != null) {
      await this.cartonization.assertFits(
        orgId,
        cartonTypeId,
        lines.map((l) => ({
          productVariantId: l.productVariantId,
          // Ceiling rather than truncation: half a unit still occupies a whole
          // one in the box, and rounding it away is how an over-full carton
          // passes the fit check.
          quantity: Math.ceil(Number(l.quantity)),
        })),
      );
    }

    await this.db.update(invPackages)
      .set({ status: "CLOSED", cartonTypeId: cartonTypeId ?? null, updatedAt: new Date() })
      .where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId)));
    await this.audit.insert(this.db, { orgId, actorUserId: userId, action: "package.closed", resourceType: "package", resourceId: String(packageId) });
    await this.cache.invalidateNamespace(CACHE_KEYS.invPackagesNamespace(orgId));
    return this.findOne(orgId, userId, packageId);
  }

  async reopen(orgId: string, userId: string, packageId: number) {
    const pkg = await this.loadPackage(orgId, userId, packageId);
    if (pkg.status !== "CLOSED") throw new ConflictException("Package is not CLOSED");

    await this.db.update(invPackages).set({ status: "OPEN", updatedAt: new Date() }).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId)));
    await this.audit.insert(this.db, { orgId, actorUserId: userId, action: "package.reopened", resourceType: "package", resourceId: String(packageId) });
    await this.cache.invalidateNamespace(CACHE_KEYS.invPackagesNamespace(orgId));
    return this.findOne(orgId, userId, packageId);
  }

  /** B6 — the queue the packing bench reads. See `packing-queue.ts`. */
  async packingQueue(orgId: string, userId: string, query: PackingQueueQueryInput) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return readPackingQueue(this.db, orgId, scope, query);
  }

  /**
   * The funnel every id-taking command comes through, and therefore the gate.
   *
   * `reconciliation`, `updateLines`, `close` and `reopen` all reach the row
   * here, and it filtered on `org_id` and the id alone — so a carton in a
   * building the caller holds nothing in could be read whole, have its entire
   * manifest replaced, be closed, or be reopened after somebody else closed it.
   * Gating here rather than at each of the four is the point: the next command
   * that loads a package by id is gated by construction.
   */
  private async loadPackage(orgId: string, userId: string, packageId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [pkg] = await this.db
      .select()
      .from(invPackages)
      .where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId), this.packageInScope(orgId, scope)))
      .limit(1);
    // 404, never 403 (§4) — a "forbidden" on a package id confirms it exists.
    if (!pkg) throw new NotFoundException("Package not found");
    return pkg;
  }

}
