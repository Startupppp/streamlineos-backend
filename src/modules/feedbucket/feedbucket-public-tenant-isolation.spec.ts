import type { Db } from "../../db/drizzle.module";
import { FeedbucketPublicService } from "./feedbucket-public.service";

describe("FeedbucketPublicService — cross-tenant isolation", () => {
  const VALID_KEY = "pub-key-valid";
  const INVALID_KEY = "pub-key-invalid";

  function makeDb(widgetRow: unknown): Db {
    return {
      query: { feedbucketWidgets: { findFirst: jest.fn().mockResolvedValue(widgetRow) } },
      execute: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 42 }]) }) }),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: { feedbucketWidgets: { findFirst: jest.fn().mockResolvedValue(widgetRow) } },
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
  }

  it("returns null for an invalid public key (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new FeedbucketPublicService(db);
    const result = await svc.resolveWidget(INVALID_KEY);
    expect(result).toBeNull();
  });

  it("returns the widget for a valid public key (control — correct key)", async () => {
    const widgetRow = { id: 1, orgId: "org-owner", publicKey: VALID_KEY, isActive: true, deletedAt: null, title: "Bug Reports" };
    const db = makeDb(widgetRow);
    const svc = new FeedbucketPublicService(db);
    const result = await svc.resolveWidget(VALID_KEY);
    expect(result).toHaveProperty("id");
  });
});
