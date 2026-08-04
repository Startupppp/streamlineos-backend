import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  invPackages,
  invPackageLines,
  invShipments,
  invPickLists,
  invPickListLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import type { ListPackagesQueryInput, CreatePackageInput, UpdatePackageLinesInput } from "./dto/shipments.schemas";

@Injectable()
export class PackagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string, query: ListPackagesQueryInput) {
    const { shipmentId, status, page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${shipmentId ?? ""}:${status ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invPackagesNamespace(orgId), `list:${hash}`, async () => {
      const conditions = [eq(invPackages.orgId, orgId)];
      if (shipmentId) conditions.push(eq(invPackages.shipmentId, shipmentId));
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

  async findOne(orgId: string, packageId: number) {
    return this.cache.cachedVersioned(CACHE_KEYS.invPackagesNamespace(orgId), `detail:${packageId}`, async () => {
      const [pkg] = await this.db.select().from(invPackages).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId))).limit(1);
      if (!pkg) throw new NotFoundException("Package not found");
      const lines = await this.db.select().from(invPackageLines).where(eq(invPackageLines.packageId, packageId));
      return { ...pkg, lines };
    }, CACHE_TTL.MEDIUM);
  }

  async create(orgId: string, userId: string, input: CreatePackageInput) {
    const packageNumber = await this.numSeq.next(orgId, "PACKAGE");
    const pkg = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(invPackages).values({
        orgId,
        packageNumber,
        shipmentId: input.shipmentId ?? null,
        weight: input.weight ?? null,
        dimensionsL: input.dimensionsL ?? null,
        dimensionsW: input.dimensionsW ?? null,
        dimensionsH: input.dimensionsH ?? null,
        createdBy: userId,
      }).returning();
      if (input.lines && input.lines.length > 0) {
        await tx.insert(invPackageLines).values(
          input.lines.map((l) => ({
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

  async updateLines(orgId: string, userId: string, packageId: number, input: UpdatePackageLinesInput) {
    const [pkg] = await this.db.select().from(invPackages).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId))).limit(1);
    if (!pkg) throw new NotFoundException("Package not found");
    if (pkg.status !== "OPEN") throw new ConflictException("Package is not OPEN");

    await this.db.transaction(async (tx) => {
      await tx.delete(invPackageLines).where(eq(invPackageLines.packageId, packageId));
      await tx.insert(invPackageLines).values(
        input.lines.map((l) => ({
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
    return this.findOne(orgId, packageId);
  }

  async close(orgId: string, userId: string, packageId: number) {
    const [pkg] = await this.db.select().from(invPackages).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId))).limit(1);
    if (!pkg) throw new NotFoundException("Package not found");
    if (pkg.status !== "OPEN") throw new ConflictException("Package is not OPEN");

    const lines = await this.db.select().from(invPackageLines).where(eq(invPackageLines.packageId, packageId));

    if (pkg.shipmentId != null) {
      const [shipment] = await this.db.select().from(invShipments).where(and(eq(invShipments.id, pkg.shipmentId), eq(invShipments.orgId, orgId))).limit(1);
      if (shipment && shipment.soId != null) {
        const pickLines = await this.db
          .select({ productVariantId: invPickListLines.productVariantId, quantityPicked: invPickListLines.quantityPicked })
          .from(invPickListLines)
          .innerJoin(invPickLists, eq(invPickListLines.pickListId, invPickLists.id))
          .where(and(eq(invPickLists.soId, shipment.soId), eq(invPickLists.orgId, orgId)));

        const pickedMap = new Map<number, number>();
        for (const pl of pickLines) {
          const cur = pickedMap.get(pl.productVariantId) ?? 0;
          pickedMap.set(pl.productVariantId, cur + parseFloat(pl.quantityPicked));
        }
        for (const line of lines) {
          const picked = pickedMap.get(line.productVariantId) ?? 0;
          if (picked < parseFloat(line.quantity)) {
            throw new BadRequestException(INV_ERRORS.PACKAGE_CONTENT_MISMATCH);
          }
        }
      }
    }

    await this.db.update(invPackages).set({ status: "CLOSED", updatedAt: new Date() }).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId)));
    await this.audit.insert(this.db, { orgId, actorUserId: userId, action: "package.closed", resourceType: "package", resourceId: String(packageId) });
    await this.cache.invalidateNamespace(CACHE_KEYS.invPackagesNamespace(orgId));
    return this.findOne(orgId, packageId);
  }

  async reopen(orgId: string, userId: string, packageId: number) {
    const [pkg] = await this.db.select().from(invPackages).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId))).limit(1);
    if (!pkg) throw new NotFoundException("Package not found");
    if (pkg.status !== "CLOSED") throw new ConflictException("Package is not CLOSED");

    await this.db.update(invPackages).set({ status: "OPEN", updatedAt: new Date() }).where(and(eq(invPackages.id, packageId), eq(invPackages.orgId, orgId)));
    await this.audit.insert(this.db, { orgId, actorUserId: userId, action: "package.reopened", resourceType: "package", resourceId: String(packageId) });
    await this.cache.invalidateNamespace(CACHE_KEYS.invPackagesNamespace(orgId));
    return this.findOne(orgId, packageId);
  }
}
