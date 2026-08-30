import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { MfaService } from "./mfa.service";

describe("MfaService — cross-tenant isolation", () => {
  const USER_ID = "user-abc";
  const OTHER_USER_ID = "user-xyz";

  function makeDb(userRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(userRow);
    return {
      query: { users: { findFirst }, mfaBackupCodes: { findMany: jest.fn().mockResolvedValue([]) } },
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
          delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        }),
      ),
    } as unknown as Db;
  }

  it("throws NotFoundException for a non-existent user id (isolation — no cross-user totp access)", async () => {
    const db = makeDb(null);
    const mockDispatch = { emit: jest.fn() } as any;
    const mockMfaPolicy = { resolve: jest.fn(), invalidateUser: jest.fn() } as any;
    const svc = new MfaService(db, mockDispatch, mockMfaPolicy);
    await expect(svc.status(OTHER_USER_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns status for a valid user id (control — correct user)", async () => {
    const db = makeDb({ id: USER_ID, totpEnabled: false });
    const mockDispatch = { emit: jest.fn() } as any;
    const mockMfaPolicy = { resolve: jest.fn(), invalidateUser: jest.fn() } as any;
    const svc = new MfaService(db, mockDispatch, mockMfaPolicy);
    const result = await svc.status(USER_ID);
    expect(result).toHaveProperty("enabled", false);
  });
});
