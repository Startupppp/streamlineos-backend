import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SQL, and, count, desc, eq, ne, sql } from "drizzle-orm";
import { assets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { formatDateOnly } from "../../../common/date";
import type {
  AssignAssetInput,
  CreateAssetInput,
  ListAssetsQueryInput,
  PatchAssetInput,
} from "./dto/hr-directory.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";

@Injectable()
export class AssetInventoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async list(orgId: string, query: ListAssetsQueryInput) {
    const conditions: SQL[] = [eq(assets.orgId, orgId)];
    if (query.status) conditions.push(eq(assets.status, query.status));

    const position = decodeCursor(query.cursor);
    if (position) conditions.push(keysetBeforeId(assets.createdAt, assets.id, position));

    const [rows, statusRows] = await Promise.all([
      this.db.query.assets.findMany({
        where: and(...conditions),
        orderBy: [desc(assets.createdAt), desc(assets.id)],
        limit: query.limit + 1,
      }),
      this.db
        .select({ status: assets.status, total: count() })
        .from(assets)
        .where(eq(assets.orgId, orgId))
        .groupBy(assets.status),
    ]);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));

    const counts = { total: 0, available: 0, assigned: 0, maintenance: 0, retired: 0 };
    for (const row of statusRows) {
      counts.total += row.total;
      if (row.status === "AVAILABLE") counts.available = row.total;
      if (row.status === "ASSIGNED") counts.assigned = row.total;
      if (row.status === "MAINTENANCE") counts.maintenance = row.total;
      if (row.status === "RETIRED") counts.retired = row.total;
    }

    return { data: page.data, counts, pagination: page.pagination };
  }

  async create(orgId: string, body: CreateAssetInput) {
    const existing = await this.db.query.assets.findFirst({
      where: and(
        eq(assets.orgId, orgId),
        sql`lower(trim(${assets.serialNumber})) = ${body.serialNumber.trim().toLowerCase()}`,
      ),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("An asset with this serial number already exists.");

    const [asset] = await this.db
      .insert(assets)
      .values({
        orgId,
        name: body.name,
        type: body.type,
        brand: body.brand,
        model: body.model,
        serialNumber: body.serialNumber,
        purchaseDate: body.purchaseDate ? formatDateOnly(body.purchaseDate) : undefined,
        purchaseCost: body.purchaseCost?.toString(),
        location: body.location,
        notes: body.notes,
        status: "AVAILABLE",
      })
      .returning();

    return asset;
  }

  async assign(orgId: string, body: AssignAssetInput) {
    const target = await this.db.query.assets.findFirst({
      where: and(eq(assets.id, body.assetId), eq(assets.orgId, orgId)),
      columns: { assignedTo: true, name: true, type: true, serialNumber: true },
    });
    if (!target) throw new NotFoundException("Asset not found.");

    await this.db
      .update(assets)
      .set({
        assignedTo: body.assignedTo,
        status: body.assignedTo ? "ASSIGNED" : "AVAILABLE",
        updatedAt: new Date(),
      })
      .where(and(eq(assets.id, body.assetId), eq(assets.orgId, orgId)));

    if (body.assignedTo && body.assignedTo !== target.assignedTo) {
      this.dispatchAssetAssigned(orgId, body.assetId, body.assignedTo, target.name, target.type, target.serialNumber ?? null);
    }

    return { success: true };
  }

  async update(orgId: string, assetId: number, body: PatchAssetInput) {
    const existing = await this.db.query.assets.findFirst({
      where: and(eq(assets.id, assetId), eq(assets.orgId, orgId)),
      columns: { assignedTo: true, name: true, type: true, serialNumber: true },
    });
    if (!existing) throw new NotFoundException("Asset not found.");

    if (body.serialNumber !== undefined) {
      const duplicate = await this.db.query.assets.findFirst({
        where: and(
          eq(assets.orgId, orgId),
          ne(assets.id, assetId),
          sql`lower(trim(${assets.serialNumber})) = ${body.serialNumber.trim().toLowerCase()}`,
        ),
        columns: { id: true },
      });
      if (duplicate) throw new ConflictException("An asset with this serial number already exists.");
    }

    const updatePayload: Partial<typeof assets.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updatePayload.name = body.name;
    if (body.type !== undefined) updatePayload.type = body.type;
    if (body.brand !== undefined) updatePayload.brand = body.brand;
    if (body.model !== undefined) updatePayload.model = body.model;
    if (body.serialNumber !== undefined) updatePayload.serialNumber = body.serialNumber;
    if (body.assignedTo !== undefined) {
      updatePayload.assignedTo = body.assignedTo;
      updatePayload.status = body.assignedTo ? "ASSIGNED" : "AVAILABLE";
    }
    if (body.status !== undefined) updatePayload.status = body.status;
    if (body.purchaseDate !== undefined) {
      updatePayload.purchaseDate = body.purchaseDate ? formatDateOnly(body.purchaseDate) : undefined;
    }
    if (body.purchaseCost !== undefined) updatePayload.purchaseCost = body.purchaseCost?.toString();
    if (body.location !== undefined) updatePayload.location = body.location;
    if (body.notes !== undefined) updatePayload.notes = body.notes;

    await this.db
      .update(assets)
      .set(updatePayload)
      .where(and(eq(assets.id, assetId), eq(assets.orgId, orgId)));

    if (body.assignedTo && body.assignedTo !== existing.assignedTo) {
      this.dispatchAssetAssigned(
        orgId,
        assetId,
        body.assignedTo,
        body.name ?? existing.name,
        body.type ?? existing.type,
        body.serialNumber ?? existing.serialNumber ?? null,
      );
    }

    return { success: true };
  }

  private dispatchAssetAssigned(
    orgId: string,
    assetId: number,
    assignedTo: string,
    assetName: string,
    assetType: string,
    serialNumber: string | null,
  ): void {
    void (async () => {
      await this.dispatch.emit({
        eventKey: "hr.asset.assigned",
        orgId,
        targetUserIds: [assignedTo],
        entityType: "asset",
        entityId: String(assetId),
        title: "Asset assigned",
        message: `${assetName} has been assigned to you.`,
        variables: { assetName, assetType, serialNumber },
      });
    })().catch(() => undefined);
  }
}
