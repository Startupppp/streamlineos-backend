import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrTimeDevices,
  hrDeviceSyncLogs,
  hrDeviceEmployeeMappings,
} from "../../../db/schema/hr/enterprise-comp";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  CreateTimeDeviceInput,
  UpdateTimeDeviceInput,
  ListTimeDevicesInput,
  CreateSyncLogInput,
  ListSyncLogsInput,
  CreateDeviceMappingInput,
  ListDeviceMappingsInput,
} from "./dto/enterprise-comp.schemas";

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listDevices(orgId: string, input: ListTimeDevicesInput) {
    const { page, limit, status, type } = input;
    const offset = (page - 1) * limit;
    const conditions = [eq(hrTimeDevices.orgId, orgId)];
    if (status) conditions.push(eq(hrTimeDevices.status, status));
    if (type) conditions.push(eq(hrTimeDevices.type, type));
    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db.select().from(hrTimeDevices).where(where).orderBy(desc(hrTimeDevices.createdAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(hrTimeDevices).where(where),
    ]);
    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async createDevice(orgId: string, actorId: string, input: CreateTimeDeviceInput) {
    const [created] = await this.db.insert(hrTimeDevices).values({ orgId, ...input }).returning();
    await this.audit.log({ orgId, actorId, entityType: "hr_time_devices", entityId: String(created!.id), action: "created", after: created });
    return created;
  }

  async updateDevice(orgId: string, deviceId: number, actorId: string, input: UpdateTimeDeviceInput) {
    const [existing] = await this.db.select().from(hrTimeDevices).where(and(eq(hrTimeDevices.id, deviceId), eq(hrTimeDevices.orgId, orgId))).limit(1);
    if (!existing) throw new NotFoundException("Device not found");
    const [updated] = await this.db.update(hrTimeDevices).set({ ...input, updatedAt: new Date() }).where(and(eq(hrTimeDevices.id, deviceId), eq(hrTimeDevices.orgId, orgId))).returning();
    await this.audit.log({ orgId, actorId, entityType: "hr_time_devices", entityId: String(deviceId), action: "updated", before: existing, after: updated });
    return updated;
  }

  async deleteDevice(orgId: string, deviceId: number, actorId: string) {
    const [existing] = await this.db.select().from(hrTimeDevices).where(and(eq(hrTimeDevices.id, deviceId), eq(hrTimeDevices.orgId, orgId))).limit(1);
    if (!existing) throw new NotFoundException("Device not found");
    await this.db.delete(hrTimeDevices).where(and(eq(hrTimeDevices.id, deviceId), eq(hrTimeDevices.orgId, orgId)));
    await this.audit.log({ orgId, actorId, entityType: "hr_time_devices", entityId: String(deviceId), action: "deleted", before: existing });
  }

  async ingestSyncLog(orgId: string, input: CreateSyncLogInput) {
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .select({ id: hrTimeDevices.id })
        .from(hrTimeDevices)
        .where(and(eq(hrTimeDevices.id, input.deviceId), eq(hrTimeDevices.orgId, orgId)))
        .limit(1);
      if (!device) throw new NotFoundException("Device not found");

      const [log] = await tx.insert(hrDeviceSyncLogs).values({ orgId, ...input }).returning();

      if (input.status !== "failed") {
        await tx
          .update(hrTimeDevices)
          .set({ lastSyncAt: new Date() })
          .where(and(eq(hrTimeDevices.id, input.deviceId), eq(hrTimeDevices.orgId, orgId)));
      }

      return log;
    });
  }

  async listSyncLogs(orgId: string, input: ListSyncLogsInput) {
    const { page, limit, deviceId, status } = input;
    const offset = (page - 1) * limit;
    const conditions = [eq(hrDeviceSyncLogs.orgId, orgId)];
    if (deviceId) conditions.push(eq(hrDeviceSyncLogs.deviceId, deviceId));
    if (status) conditions.push(eq(hrDeviceSyncLogs.status, status));
    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db.select().from(hrDeviceSyncLogs).where(where).orderBy(desc(hrDeviceSyncLogs.syncedAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(hrDeviceSyncLogs).where(where),
    ]);
    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async listFailedSyncs(orgId: string, limit = 50) {
    return this.db.select().from(hrDeviceSyncLogs).where(and(eq(hrDeviceSyncLogs.orgId, orgId), eq(hrDeviceSyncLogs.status, "failed"))).orderBy(desc(hrDeviceSyncLogs.syncedAt)).limit(limit);
  }

  async detectDuplicatePunches(orgId: string, deviceId: number) {
    const rows = await this.db.execute(
      sql`SELECT biometric_user_id, user_id, date_trunc('minute', punch_time) AS punch_window, count(*) AS cnt
          FROM biometric_logs
          WHERE org_id = ${orgId} AND device_id = ${deviceId}
          GROUP BY biometric_user_id, user_id, punch_window
          HAVING count(*) > 1
          ORDER BY punch_window DESC
          LIMIT 100`,
    );
    return rows;
  }

  async createMapping(orgId: string, actorId: string, input: CreateDeviceMappingInput) {
    const [device] = await this.db.select({ id: hrTimeDevices.id }).from(hrTimeDevices).where(and(eq(hrTimeDevices.id, input.deviceId), eq(hrTimeDevices.orgId, orgId))).limit(1);
    if (!device) throw new NotFoundException("Device not found");
    const [created] = await this.db.insert(hrDeviceEmployeeMappings).values({ orgId, ...input }).returning();
    await this.audit.log({ orgId, actorId, entityType: "hr_device_employee_mappings", entityId: String(created!.id), action: "created", after: created });
    return created;
  }

  async listMappings(orgId: string, input: ListDeviceMappingsInput) {
    const { page, limit, deviceId, userId } = input;
    const offset = (page - 1) * limit;
    const conditions = [eq(hrDeviceEmployeeMappings.orgId, orgId)];
    if (deviceId) conditions.push(eq(hrDeviceEmployeeMappings.deviceId, deviceId));
    if (userId) conditions.push(eq(hrDeviceEmployeeMappings.userId, userId));
    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db.select().from(hrDeviceEmployeeMappings).where(where).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(hrDeviceEmployeeMappings).where(where),
    ]);
    const total = totalResult[0]?.total ?? 0;
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
}
