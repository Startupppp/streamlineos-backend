import { Logger } from "@nestjs/common";
import { MailAccountsService, type MailAccount } from "./mail-accounts.service";
import { MailService } from "./mail.service";
import { ComposioToolError } from "../integrations/core/composio.gateway";
import type { Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { GmailMailProvider } from "./providers/gmail-mail.provider";
import type { OutlookMailProvider } from "./providers/outlook-mail.provider";
import type { CacheService } from "../../common/cache/cache.service";
import type { MailMetadataService } from "./mail-metadata.service";
import type { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, _orgId: string, fn: (_tx: unknown) => Promise<unknown>) => fn(_db),
  ),
}));

const mockedRunInNew = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

const ORG = "org-1";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

function makeDb(wheres: unknown[], reject?: Error) {
  const update = jest.fn().mockImplementation(() => ({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((w: unknown) => {
        wheres.push(w);
        return reject ? Promise.reject(reject) : Promise.resolve(undefined);
      }),
    }),
  }));
  return { db: { update } as unknown as Db, update };
}

function account(id: number): MailAccount {
  return {
    id,
    provider: "gmail",
    accountEmail: `a${id}@example.com`,
    accountLabel: null,
    status: "active",
    isPrimary: id === 1,
    composioConnectedAccountId: `conn-${id}`,
  };
}

describe("mail reauth marking — one bulk write, and never a silent one", () => {
  afterEach(() => jest.restoreAllMocks());

  it("flags every failing mailbox with ONE update, not one per account", async () => {
    const wheres: unknown[] = [];
    const { db, update } = makeDb(wheres);
    const svc = new MailAccountsService(db);

    await svc.markNeedsReauthMany([1, 2, 3], ORG);

    expect(update).toHaveBeenCalledTimes(1);
    const vals = sqlValues(wheres[0]);
    expect(vals).toEqual(expect.arrayContaining([1, 2, 3, ORG]));
  });

  it("collapses a repeated account id instead of writing it twice", async () => {
    const wheres: unknown[] = [];
    const { db, update } = makeDb(wheres);

    await new MailAccountsService(db).markNeedsReauthMany([7, 7, 7], ORG);

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("issues no statement at all when nothing failed", async () => {
    const wheres: unknown[] = [];
    const { db, update } = makeDb(wheres);

    await new MailAccountsService(db).markNeedsReauthMany([], ORG);

    expect(update).not.toHaveBeenCalled();
  });

  it("LOGS a failed flag write instead of swallowing it, and still does not reject", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const wheres: unknown[] = [];
    const { db } = makeDb(wheres, new Error("connection terminated"));

    await expect(new MailAccountsService(db).markNeedsReauth(9, ORG)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("needs_reauth");
  });

  it("runs the reauth flag write in a fresh independent transaction, not the ambient request transaction, so a GET handler's read-only transaction (SQLSTATE 25006) cannot abort the status update", async () => {
    mockedRunInNew.mockClear();
    const wheres: unknown[] = [];
    const { db } = makeDb(wheres);

    await new MailAccountsService(db).markNeedsReauthMany([42], ORG);

    expect(mockedRunInNew).toHaveBeenCalledTimes(1);
    expect(mockedRunInNew.mock.calls[0]?.[1]).toBe(ORG);
  });

  it("listMessages flags both expired mailboxes in one awaited write", async () => {
    const wheres: unknown[] = [];
    const update = jest.fn();
    let settled = false;
    update.mockImplementation(() => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((w: unknown) => {
          wheres.push(w);
          return new Promise<void>((resolve) =>
            setTimeout(() => {
              settled = true;
              resolve();
            }, 0),
          );
        }),
      }),
    }));
    const db = { update } as unknown as Db;

    const accounts = new MailAccountsService(db);
    jest.spyOn(accounts, "listAccounts").mockResolvedValue([account(1), account(2)]);

    const gmail = {
      listMessages: jest.fn().mockRejectedValue(new ComposioToolError("grant expired", true)),
    } as unknown as GmailMailProvider;

    const service = new MailService(
      accounts,
      gmail,
      {} as unknown as OutlookMailProvider,
      {} as unknown as CacheService,
      {} as unknown as MailMetadataService,
      {} as unknown as MailSyncCheckpointService,
      { ENCRYPTION_KEY: "mail-cursor-test-secret" },
    );

    const res = await service.listMessages(ORG, "user-1", null, "inbox", "all", 25, undefined, "q");

    expect(res.accountErrors).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    const vals = sqlValues(wheres[0]);
    expect(vals).toEqual(expect.arrayContaining([1, 2, ORG]));
  });
});
