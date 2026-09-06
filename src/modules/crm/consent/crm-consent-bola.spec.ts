jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { CrmConsentService } from "./crm-consent.service";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function thenableResolve<T>(value: T) {
  const p = Promise.resolve(value);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
}

function makeService(contactExists: boolean) {
  let selectCall = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) {
        const row = contactExists ? [{ id: 1 }] : [];
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(row) }),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      };
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue(thenableResolve([])),
        ...thenableResolve([]),
      }),
    }),
  } as unknown as Db;
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const svc = new CrmConsentService(db, audit as never);
  return { svc, db };
}

const INPUT = {
  contactId: 1,
  channel: "EMAIL" as const,
  status: "OPTED_IN" as const,
  source: "USER_ENTRY" as const,
  recordedByUserId: "u1",
};

describe("CrmConsentService.record — cross-tenant isolation", () => {
  it("throws 404 when contact belongs to a different org (cross-tenant)", async () => {
    const { svc } = makeService(false);
    await expect(svc.record(ATTACKER_ORG, INPUT)).rejects.toThrow(NotFoundException);
  });

  it("throws 404 when contact does not exist (unknown id)", async () => {
    const { svc } = makeService(false);
    await expect(svc.record(OWNER_ORG, { ...INPUT, contactId: 9999 })).rejects.toThrow(NotFoundException);
  });

  it("records consent when contact belongs to the caller's org (own contact)", async () => {
    const { svc, db } = makeService(true);
    await expect(svc.record(OWNER_ORG, INPUT)).resolves.toBeUndefined();
    expect(db.insert).toHaveBeenCalled();
  });
});
