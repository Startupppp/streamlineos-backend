import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { biometricDevices, biometricLogs } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";

@Injectable()
export class BiometricService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listDevices(orgId: string) {
    return this.db.select().from(biometricDevices).where(eq(biometricDevices.orgId, orgId));
  }

  async createDevice(orgId: string, data: { name: string; ipAddress: string; port?: number; vendor?: string; location?: string }) {
    const [device] = await this.db.insert(biometricDevices).values({ orgId, ...data }).returning();
    return device;
  }

  async updateDevice(orgId: string, id: number, data: Partial<typeof biometricDevices.$inferInsert>) {
    const [device] = await this.db.update(biometricDevices).set(data)
      .where(and(eq(biometricDevices.id, id), eq(biometricDevices.orgId, orgId))).returning();
    if (!device) throw new NotFoundException("Device not found");
    return device;
  }

  async getLogs(orgId: string) {
    return this.db.select().from(biometricLogs).where(eq(biometricLogs.orgId, orgId))
      .orderBy(desc(biometricLogs.punchTime)).limit(200);
  }
}
