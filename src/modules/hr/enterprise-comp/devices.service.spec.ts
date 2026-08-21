import { ConflictException } from "@nestjs/common";
import { DevicesService } from "./devices.service";

function selectOne(row: unknown) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(row == null ? [] : [row]),
      }),
    }),
  };
}

function duplicatePunchQuery(rows: unknown[]) {
  return {
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          groupBy: jest.fn().mockReturnValue({
            having: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(rows),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

describe("DevicesService legacy biometric compatibility", () => {
  it("fails closed instead of treating an unrelated canonical id as a legacy device id", async () => {
    const select = jest.fn().mockReturnValue(selectOne({ serialNumber: "NATIVE-001" }));
    const service = new DevicesService(
      { select } as never,
      { log: jest.fn() } as never,
    );

    await expect(service.detectDuplicatePunches("org-1", 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit legacy link before reading duplicate punch windows", async () => {
    const expected = [
      {
        biometricUserId: "badge-1",
        userId: "user-1",
        punchWindow: "2026-08-18T09:00:00.000Z",
        count: 2,
      },
    ];
    const select = jest
      .fn()
      .mockReturnValueOnce(
        selectOne({ serialNumber: "legacy-biometric-device:31" }),
      )
      .mockReturnValueOnce(duplicatePunchQuery(expected));
    const service = new DevicesService(
      { select } as never,
      { log: jest.fn() } as never,
    );

    await expect(service.detectDuplicatePunches("org-1", 9)).resolves.toEqual(expected);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("prevents a canonical delete from orphaning its legacy biometric source", async () => {
    const db = {
      select: jest.fn().mockReturnValue(
        selectOne({
          id: 9,
          serialNumber: "legacy-biometric-device:31",
        }),
      ),
      delete: jest.fn(),
    };
    const audit = { log: jest.fn() };
    const service = new DevicesService(db as never, audit as never);

    await expect(service.deleteDevice("org-1", 9, "actor-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(db.delete).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
