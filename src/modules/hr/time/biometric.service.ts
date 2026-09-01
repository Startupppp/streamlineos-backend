import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { biometricDevices, biometricLogs, hrTimeDevices } from "../../../db/schema";
import { legacyBiometricDeviceSerial } from "../device-compat/legacy-biometric-device-link";

type CreateBiometricDevice = {
  name: string;
  ipAddress: string;
  port?: number;
  vendor?: string;
  location?: string;
};

type UpdateBiometricDevice = Partial<CreateBiometricDevice>;

function canonicalMirror(
  device: typeof biometricDevices.$inferSelect,
): typeof hrTimeDevices.$inferInsert {
  return {
    orgId: device.orgId,
    name: device.name,
    serialNumber: legacyBiometricDeviceSerial(device.id),
    type: "biometric",
    status: device.isOnline ? "active" : "inactive",
    lastSyncAt: device.lastSyncAt,
  };
}

@Injectable()
export class BiometricService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listDevices(orgId: string) {
    return this.db
      .select()
      .from(biometricDevices)
      .where(eq(biometricDevices.orgId, orgId))
      .orderBy(desc(biometricDevices.id))
      .limit(100);
  }

  createDevice(orgId: string, data: CreateBiometricDevice) {
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .insert(biometricDevices)
        .values({ orgId, ...data })
        .returning();
      if (!device) throw new Error("Failed to create biometric device");
      await tx.insert(hrTimeDevices).values(canonicalMirror(device));
      return device;
    });
  }

  updateDevice(orgId: string, biometricDeviceId: number, data: UpdateBiometricDevice) {
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .update(biometricDevices)
        .set(data)
        .where(
          and(
            eq(biometricDevices.id, biometricDeviceId),
            eq(biometricDevices.orgId, orgId),
          ),
        )
        .returning();
      if (!device) throw new NotFoundException("Device not found");

      const mirror = canonicalMirror(device);
      const [linked] = await tx
        .select({ id: hrTimeDevices.id })
        .from(hrTimeDevices)
        .where(
          and(
            eq(hrTimeDevices.orgId, orgId),
            eq(hrTimeDevices.serialNumber, mirror.serialNumber),
          ),
        )
        .limit(1);
      if (linked) {
        await tx
          .update(hrTimeDevices)
          .set({
            name: mirror.name,
            status: mirror.status,
            lastSyncAt: mirror.lastSyncAt,
            updatedAt: new Date(),
          })
          .where(and(eq(hrTimeDevices.id, linked.id), eq(hrTimeDevices.orgId, orgId)));
      } else {
        await tx.insert(hrTimeDevices).values(mirror);
      }
      return device;
    });
  }

  getLogs(orgId: string) {
    return this.db
      .select()
      .from(biometricLogs)
      .where(eq(biometricLogs.orgId, orgId))
      .orderBy(desc(biometricLogs.punchTime))
      .limit(100);
  }
}
