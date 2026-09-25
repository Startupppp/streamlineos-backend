import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbPageTrashService } from "./kb-page-trash.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

jest.mock("./kb-page-attachment-purge", () => ({
  recordPageAttachmentPurge: jest.fn().mockResolvedValue([]),
  attemptPageAttachmentPurge: jest.fn().mockResolvedValue(undefined),
  purgeOrphanedKbMedia: jest.fn().mockResolvedValue(0),
}));

describe("KbPageTrashService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";
  const PAGE_ID = 42;

  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  };
  const auditMock = { log: jest.fn() };
  const storageMock = {} as never;
  const configMock = { R2_KB_BUCKET_NAME: "test-bucket" } as never;
  const treeMock = { restore: jest.fn() };

  function makeUser(orgId: string): CurrentUserContext {
    return { orgId, userId: "user-1", isOrgOwner: false } as CurrentUserContext;
  }

  function makeDb(findResult: unknown): { db: Db; findFirstWhereArgs: unknown[] } {
    const findFirstWhereArgs: unknown[] = [];
    const db = {
      query: {
        kbPages: {
          findFirst: jest
            .fn()
            .mockImplementation((opts: { where?: unknown } = {}) => {
              findFirstWhereArgs.push(opts.where);
              return Promise.resolve(findResult);
            }),
        },
      },
      transaction: jest
        .fn()
        .mockImplementation(
          async (cb: (tx: unknown) => Promise<unknown>) =>
            cb({
              execute: jest.fn().mockResolvedValue([]),
              delete: () => ({ where: jest.fn().mockResolvedValue([]) }),
            }),
        ),
    } as unknown as Db;
    return { db, findFirstWhereArgs };
  }

  it("hardDelete throws NotFoundException for a page in another org — cross-tenant denial is enforced by the WHERE predicate", async () => {
    const { db, findFirstWhereArgs } = makeDb(null);
    const svc = new KbPageTrashService(
      db,
      auditMock as never,
      storageMock,
      configMock,
      auth as never,
      treeMock as never,
      { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(svc.hardDelete(makeUser(ATTACKER_ORG), PAGE_ID)).rejects.toThrow(
      NotFoundException,
    );

    const predicateVals = findFirstWhereArgs.flatMap((w) => sqlValues(w));
    expect(predicateVals).toContain(ATTACKER_ORG);
    expect(predicateVals).not.toContain(OWNER_ORG);
  });

  it("hardDelete succeeds for a page in the owning org (same-tenant control)", async () => {
    const { db } = makeDb({ id: PAGE_ID, title: "Owner page" });
    const svc = new KbPageTrashService(
      db,
      auditMock as never,
      storageMock,
      configMock,
      auth as never,
      treeMock as never,
      { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(svc.hardDelete(makeUser(OWNER_ORG), PAGE_ID)).resolves.toBeUndefined();
  });
});
