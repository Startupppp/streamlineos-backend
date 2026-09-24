jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(_db),
}));

import type { Db } from "../../db/drizzle.types";
import { CallRecordingConsentService } from "./call-recording-consent.service";
import type { CallConsentVerdict } from "./call-recording-consent";

const ORG = "org-1";
const ACTIVITY = "act-1";

const REFUSED_VERDICT: CallConsentVerdict = {
  allowed: false,
  regime: "two-party",
  jurisdiction: "US-CA",
  reason: "jurisdiction-unrecorded",
  ruleVersion: 1,
  note: "No jurisdiction recorded for this call.",
};

describe("CallRecordingConsentService.recordRefusal — GET-safe write", () => {
  function makeInsertDb(): { db: Db; insertSpy: jest.Mock } {
    const insertSpy = jest.fn();
    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    insertSpy.mockReturnValue({ values });

    const db = {
      insert: insertSpy,
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    return { db, insertSpy };
  }

  it("records the refusal in its own fresh transaction so the read-only GET request transaction is not aborted by the INSERT with SQLSTATE 25006", async () => {
    const { db, insertSpy } = makeInsertDb();
    const svc = new CallRecordingConsentService(db);

    await svc.recordRefusal(ORG, ACTIVITY, REFUSED_VERDICT, null);

    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the verdict is allowed — no INSERT fires on a permitted call", async () => {
    const { db, insertSpy } = makeInsertDb();
    const svc = new CallRecordingConsentService(db);

    const allowedVerdict: CallConsentVerdict = {
      allowed: true as const,
      regime: "one-party" as const,
      jurisdiction: "US-NY",
      ruleVersion: 1,
    };
    await svc.recordRefusal(ORG, ACTIVITY, allowedVerdict, null);

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("swallows an INSERT failure so the GET route still returns its result rather than a 500", async () => {
    const onConflictDoUpdate = jest.fn().mockRejectedValue(new Error("db error"));
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insertSpy = jest.fn().mockReturnValue({ values });
    const db = {
      insert: insertSpy,
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const svc = new CallRecordingConsentService(db);

    await expect(svc.recordRefusal(ORG, ACTIVITY, REFUSED_VERDICT, null)).resolves.toBeUndefined();
  });
});
