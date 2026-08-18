import { biometricDevices, hrTimeDevices } from "../../../db/schema";
import { BiometricService } from "./biometric.service";

describe("BiometricService canonical device compatibility", () => {
  it("creates the legacy network record and canonical device mirror atomically", async () => {
    const legacyValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([
        {
          id: 17,
          orgId: "org-1",
          name: "Front Door",
          ipAddress: "192.0.2.10",
          port: 4370,
          vendor: "ZKTeco",
          location: "Reception",
          isOnline: false,
          lastSyncAt: null,
          createdAt: new Date("2026-08-18T00:00:00.000Z"),
        },
      ]),
    });
    const canonicalValues = jest.fn().mockResolvedValue(undefined);
    const tx = {
      insert: jest.fn().mockImplementation((table: unknown) => {
        if (table === biometricDevices) return { values: legacyValues };
        if (table === hrTimeDevices) return { values: canonicalValues };
        throw new Error("Unexpected table");
      }),
    };
    const db = {
      transaction: jest.fn().mockImplementation((operation: (value: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const service = new BiometricService(db as never);

    const created = await service.createDevice("org-1", {
      name: "Front Door",
      ipAddress: "192.0.2.10",
      location: "Reception",
    });

    expect(created.id).toBe(17);
    expect(canonicalValues).toHaveBeenCalledWith({
      orgId: "org-1",
      name: "Front Door",
      serialNumber: "legacy-biometric-device:17",
      type: "biometric",
      status: "inactive",
      lastSyncAt: null,
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("backfills a missing canonical mirror when a legacy device is updated", async () => {
    const device = {
      id: 5,
      orgId: "org-1",
      name: "Updated Gate",
      ipAddress: "192.0.2.20",
      port: 4370,
      vendor: "ZKTeco",
      location: "Gate",
      isOnline: true,
      lastSyncAt: new Date("2026-08-18T01:00:00.000Z"),
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
    };
    const returning = jest.fn().mockResolvedValue([device]);
    const canonicalValues = jest.fn().mockResolvedValue(undefined);
    const tx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning }),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: canonicalValues }),
    };
    const db = {
      transaction: jest.fn().mockImplementation((operation: (value: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const service = new BiometricService(db as never);

    await service.updateDevice("org-1", 5, { name: "Updated Gate" });

    expect(canonicalValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        name: "Updated Gate",
        serialNumber: "legacy-biometric-device:5",
        status: "active",
      }),
    );
  });
});
