import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { assetReturns, employeeDevices, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { formatDateOnly } from "../../../common/date";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import type {
  CreateAssetReturnInput,
  CreateDeviceInput,
  PatchAssetReturnInput,
  PatchDeviceInput,
} from "./dto/hr-directory.schemas";

@Injectable()
export class AssetsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listAssetReturns(orgId: string, userId: string, scope: DataScope) {
    const rows = await this.db
      .select({
        id: assetReturns.id,
        orgId: assetReturns.orgId,
        userId: assetReturns.userId,
        assetId: assetReturns.assetId,
        assetName: assetReturns.assetName,
        status: assetReturns.status,
        returnedAt: assetReturns.returnedAt,
        condition: assetReturns.condition,
        notes: assetReturns.notes,
        createdAt: assetReturns.createdAt,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
      })
      .from(assetReturns)
      .leftJoin(users, eq(assetReturns.userId, users.id))
      .where(and(eq(assetReturns.orgId, orgId), applyScope(scope, orgId, userId, { ownerColumn: assetReturns.userId })))
      .orderBy(desc(assetReturns.createdAt))
      .limit(100);

    return rows.map((r) => {
      const name = `${r.userFirstName ?? ""} ${r.userLastName ?? ""}`.trim();
      const employeeName = name || r.userEmail || null;
      return {
        id: r.id,
        orgId: r.orgId,
        userId: r.userId,
        assetId: r.assetId,
        assetName: r.assetName,
        assetType: null as string | null,
        serialNumber: null as string | null,
        status: r.status,
        returnedAt: r.returnedAt,
        condition: r.condition,
        notes: r.notes,
        createdAt: r.createdAt,
        employeeName,
      };
    });
  }

  async createAssetReturn(orgId: string, body: CreateAssetReturnInput) {
    const [record] = await this.db
      .insert(assetReturns)
      .values({
        orgId,
        userId: body.userId,
        assetId: body.assetId ?? null,
        assetName: body.assetName,
        condition: body.condition ?? null,
        notes: body.notes ?? null,
        status: "PENDING",
      })
      .returning();

    return record;
  }

  async updateAssetReturn(orgId: string, returnId: number, body: PatchAssetReturnInput) {
    const [existing] = await this.db
      .select()
      .from(assetReturns)
      .where(and(eq(assetReturns.id, returnId), eq(assetReturns.orgId, orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Asset return record not found.");
    if (existing.status === "RETURNED" || existing.status === "DAMAGED" || existing.status === "LOST") {
      throw new BadRequestException(
        `This return record is already finalized as ${existing.status.toLowerCase()} and cannot be changed.`,
      );
    }

    const [updated] = await this.db
      .update(assetReturns)
      .set({
        status: body.status,
        condition: body.condition ?? existing.condition,
        notes: body.notes ?? existing.notes,
        returnedAt: new Date(),
      })
      .where(and(eq(assetReturns.id, returnId), eq(assetReturns.orgId, orgId)))
      .returning();

    return updated;
  }

  async listDevices(orgId: string) {
    const rows = await this.db
      .select({
        id: employeeDevices.id,
        orgId: employeeDevices.orgId,
        userId: employeeDevices.userId,
        deviceType: employeeDevices.deviceType,
        deviceName: employeeDevices.deviceName,
        serialNumber: employeeDevices.serialNumber,
        brand: employeeDevices.brand,
        model: employeeDevices.model,
        assignedDate: employeeDevices.assignedDate,
        returnDate: employeeDevices.returnDate,
        status: employeeDevices.status,
        notes: employeeDevices.notes,
        createdAt: employeeDevices.createdAt,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
      })
      .from(employeeDevices)
      .innerJoin(users, eq(employeeDevices.userId, users.id))
      .where(eq(employeeDevices.orgId, orgId))
      .orderBy(desc(employeeDevices.createdAt))
      .limit(100);

    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      userId: r.userId,
      deviceType: r.deviceType,
      deviceName: r.deviceName,
      serialNumber: r.serialNumber,
      brand: r.brand,
      model: r.model,
      assignedDate: r.assignedDate,
      returnDate: r.returnDate,
      status: r.status,
      notes: r.notes,
      createdAt: r.createdAt,
      user: { id: r.userId, firstName: r.userFirstName, lastName: r.userLastName, email: r.userEmail },
    }));
  }

  async createDevice(orgId: string, body: CreateDeviceInput) {
    const existing = await this.db.query.employeeDevices.findFirst({
      where: and(
        eq(employeeDevices.orgId, orgId),
        sql`lower(trim(${employeeDevices.serialNumber})) = ${body.serialNumber.trim().toLowerCase()}`,
      ),
      columns: { id: true },
    });

    if (existing) {
      throw new ConflictException("A device with this serial number already exists.");
    }

    const [device] = await this.db
      .insert(employeeDevices)
      .values({
        orgId,
        userId: body.userId,
        deviceType: body.deviceType,
        deviceName: body.deviceName,
        serialNumber: body.serialNumber,
        brand: body.brand,
        model: body.model,
        notes: body.notes,
        assignedDate: body.assignedDate
          ? formatDateOnly(new Date(body.assignedDate))
          : formatDateOnly(new Date()),
        status: "ACTIVE",
      })
      .returning();

    return device;
  }

  async updateDevice(orgId: string, deviceId: number, body: PatchDeviceInput) {
    const existing = await this.db.query.employeeDevices.findFirst({
      columns: { id: true },
      where: and(eq(employeeDevices.id, deviceId), eq(employeeDevices.orgId, orgId)),
    });

    if (!existing) throw new NotFoundException("Device not found.");

    if (body.serialNumber !== undefined) {
      const duplicateSerial = await this.db.query.employeeDevices.findFirst({
        where: and(
          eq(employeeDevices.orgId, orgId),
          ne(employeeDevices.id, deviceId),
          sql`lower(trim(${employeeDevices.serialNumber})) = ${body.serialNumber.trim().toLowerCase()}`,
        ),
        columns: { id: true },
      });
      if (duplicateSerial) {
        throw new ConflictException("A device with this serial number already exists.");
      }
    }

    await this.db
      .update(employeeDevices)
      .set({
        ...(body.userId !== undefined && { userId: body.userId }),
        ...(body.deviceType !== undefined && { deviceType: body.deviceType }),
        ...(body.deviceName !== undefined && { deviceName: body.deviceName }),
        ...(body.serialNumber !== undefined && { serialNumber: body.serialNumber }),
        ...(body.brand !== undefined && { brand: body.brand }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.returnDate !== undefined && { returnDate: formatDateOnly(new Date(body.returnDate)) }),
        updatedAt: new Date(),
      })
      .where(and(eq(employeeDevices.id, deviceId), eq(employeeDevices.orgId, orgId)));

    return { success: true };
  }

  async deleteDevice(orgId: string, deviceId: number) {
    const existing = await this.db.query.employeeDevices.findFirst({
      columns: { id: true },
      where: and(eq(employeeDevices.id, deviceId), eq(employeeDevices.orgId, orgId)),
    });

    if (!existing) throw new NotFoundException("Device not found.");

    await this.db.delete(employeeDevices).where(and(eq(employeeDevices.id, deviceId), eq(employeeDevices.orgId, orgId)));
    return { success: true };
  }
}
