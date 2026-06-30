import { Injectable, NotFoundException } from "@nestjs/common";
import { db } from "../../db";
import { biometricDevices, biometricLogs } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";

@Injectable()
export class BiometricService {
  async listDevices(orgId: string) {
    return db.select().from(biometricDevices).where(eq(biometricDevices.orgId, orgId));
  }

  async createDevice(orgId: string, data: { name: string; ipAddress: string; port?: number; vendor?: string; location?: string }) {
    const [device] = await db.insert(biometricDevices).values({ orgId, ...data }).returning();
    return device;
  }

  async updateDevice(orgId: string, id: number, data: Partial<typeof biometricDevices.$inferInsert>) {
    const [device] = await db.update(biometricDevices).set(data)
      .where(and(eq(biometricDevices.id, id), eq(biometricDevices.orgId, orgId))).returning();
    if (!device) throw new NotFoundException("Device not found");
    return device;
  }

  async getLogs(orgId: string) {
    return db.select().from(biometricLogs).where(eq(biometricLogs.orgId, orgId))
      .orderBy(desc(biometricLogs.punchTime)).limit(200);
  }
}
