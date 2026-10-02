import { ConflictException, NotFoundException } from "@nestjs/common";
import { ApiTokensService } from "./api-tokens.service";
import { accessVersions, apiKeys, auditLogs } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

function makeDb(existing: Array<{ id: string; isRevoked: boolean }>) {
  const inserted: Array<{ table: unknown; row: unknown }> = [];
  const updated: unknown[] = [];
  const db: Record<string, unknown> = {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: unknown) => {
        inserted.push({ table, row });
        return Object.assign(Promise.resolve(undefined), {
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          returning: jest.fn().mockResolvedValue([{ id: "key-1", name: "k" }]),
        });
      }),
    })),
    select: jest.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "for"]) chain[method] = () => chain;
      chain["limit"] = () => Promise.resolve(existing);
      return chain;
    }),
    update: jest.fn((table: unknown) => {
      updated.push(table);
      return { set: () => ({ where: () => Promise.resolve(undefined) }) };
    }),
  };
  db["transaction"] = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return { db: db as unknown as Db, inserted, updated };
}

function makeDispatch() {
  return { emitInTx: jest.fn().mockResolvedValue(undefined) };
}

describe("the single API-key writer commits through the access-mutation commit", () => {
  it("issue writes the key, the version bump and the api_key.created audit on one transaction and queues the notice on it", async () => {
    const { db, inserted } = makeDb([]);
    const dispatch = makeDispatch();
    const svc = new ApiTokensService(db, dispatch as unknown as NotificationDispatchService);

    await svc.issue(
      "org-1",
      "user-1",
      { name: "k", scopes: ["leads:read"], expiresAt: null },
      { id: "key-1", keyHash: "hash", keyPrefix: "streamlineos_ab" },
    );

    expect(inserted.map((entry) => entry.table)).toEqual([apiKeys, accessVersions, auditLogs]);
    expect(inserted[2]?.row).toMatchObject({
      action: "api_key.created",
      userId: "user-1",
      orgId: "org-1",
      targetId: "key-1",
    });
    expect(dispatch.emitInTx).toHaveBeenCalledWith(db, [
      expect.objectContaining({ eventKey: "security.api_key.created", entityId: "key-1" }),
    ]);
  });

  it("revoke flips the key and audits api_key.revoked with the acting user", async () => {
    const { db, inserted, updated } = makeDb([{ id: "key-1", isRevoked: false }]);
    const svc = new ApiTokensService(db, makeDispatch() as unknown as NotificationDispatchService);

    await expect(svc.revoke("org-1", "admin-1", "key-1")).resolves.toBe("revoked");

    expect(updated).toEqual([apiKeys]);
    expect(inserted.find((entry) => entry.table === auditLogs)?.row).toMatchObject({
      action: "api_key.revoked",
      userId: "admin-1",
      targetId: "key-1",
    });
  });

  it("revoke of an already-revoked key writes nothing and the CRM route answers 409", async () => {
    const { db, inserted, updated } = makeDb([{ id: "key-1", isRevoked: true }]);
    const svc = new ApiTokensService(db, makeDispatch() as unknown as NotificationDispatchService);

    await expect(svc.revokeToken("org-1", "admin-1", "key-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(updated).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("revoke of a key outside the org answers 404 and writes nothing", async () => {
    const { db, inserted, updated } = makeDb([]);
    const svc = new ApiTokensService(db, makeDispatch() as unknown as NotificationDispatchService);

    await expect(svc.revoke("org-1", "admin-1", "key-foreign")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updated).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
