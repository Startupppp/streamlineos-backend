import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { assets, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { formatDateOnly } from "./date.helpers";
import type { AssignAssetInput, CreateAssetInput, PatchAssetInput } from "./dto/hr-directory.schemas";

@Injectable()
export class AssetInventoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  list(orgId: string) {
    return this.db.query.assets.findMany({
      where: eq(assets.orgId, orgId),
      orderBy: [desc(assets.createdAt)],
    });
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
        purchaseDate: body.purchaseDate ? formatDateOnly(new Date(body.purchaseDate)) : undefined,
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
      this.dispatchAssetAssigned(body.assignedTo, target.name, target.type, target.serialNumber ?? null);
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
      updatePayload.purchaseDate = body.purchaseDate ? formatDateOnly(new Date(body.purchaseDate)) : undefined;
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
        body.assignedTo,
        body.name ?? existing.name,
        body.type ?? existing.type,
        body.serialNumber ?? existing.serialNumber ?? null,
      );
    }

    return { success: true };
  }

  private dispatchAssetAssigned(
    assignedTo: string,
    assetName: string,
    assetType: string,
    serialNumber: string | null,
  ): void {
    void (async () => {
      const employee = await this.db.query.users.findFirst({
        where: eq(users.id, assignedTo),
        columns: { email: true, name: true },
      });
      if (!employee?.email) return;
      await this.email.sendAssetAssignedEmail(
        employee.email,
        employee.name ?? "Employee",
        assetName,
        assetType,
        serialNumber,
      );
    })().catch(() => undefined);
  }
}
