jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL } from "drizzle-orm";
import { IntegrationsService } from "./integrations.service";
import type { ComposioGateway } from "./composio.gateway";
import type { Db } from "../../../db/drizzle.module";
import type { AppConfig } from "../../../config/env.validation";

/**
 * Revoking a mailbox has to take the mirror of it with it.
 *
 * `mail_message_metadata` holds subject lines, sender addresses and snippets of
 * the member's real mail; `mail_sync_checkpoints` holds the provider position
 * that resumes a sync into it. Neither has a foreign key to
 * `user_integration_connections` — `account_id` is a bare integer — so deleting
 * the connection row left both behind with nothing that would ever reach them
 * again. `markStaleForAccount` and `clearPositions` were written for this and
 * had no caller anywhere in the repository.
 *
 * The purge must run inside the caller's transaction: a mirror that survives a
 * half-failed disconnect is the same leak with an extra step.
 */

const dialect = new PgDialect();

const ORG = "org-1";
const USER = "user-A";
const CONNECTION_ID = 7;

interface DeleteCall {
  readonly table: string;
  readonly where: SQL;
  readonly insideTransaction: boolean;
}

function render(where: SQL): string {
  return dialect.sqlToQuery(where).sql;
}

function makeHarness(opts: { transactional: boolean } = { transactional: true }) {
  const deletes: DeleteCall[] = [];
  let insideTransaction = false;

  const deleteFor = (owner: "tx" | "db") =>
    jest.fn().mockImplementation((table: unknown) => ({
      where: jest.fn().mockImplementation((pred: SQL) => {
        deletes.push({
          table: getTableName(table as Parameters<typeof getTableName>[0]),
          where: pred,
          insideTransaction: owner === "tx" ? insideTransaction : false,
        });
        return Promise.resolve(undefined);
      }),
    }));

  const tx = {
    delete: deleteFor("tx"),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
  };

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            {
              id: CONNECTION_ID,
              isPrimary: false,
              composioConnectedAccountId: "ca_mail",
            },
          ]),
        }),
      }),
    }),
    delete: deleteFor("db"),
    transaction: jest.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
      if (!opts.transactional) return cb(tx);
      insideTransaction = true;
      try {
        return await cb(tx);
      } finally {
        insideTransaction = false;
      }
    }),
  } as unknown as Db;

  const gateway = {
    deleteConnectedAccount: jest.fn().mockResolvedValue(undefined),
  } as unknown as ComposioGateway;

  const service = new IntegrationsService(db, { APP_URL: "https://app.example.com" } as AppConfig, gateway);
  return { service, deletes };
}

describe("IntegrationsService.disconnect — the mirrored mailbox goes with the connection", () => {
  it("BITE: deletes the mirrored mail rows for the revoked account", async () => {
    const h = makeHarness();
    await h.service.disconnect(ORG, USER, CONNECTION_ID);

    const purge = h.deletes.find((d) => d.table === "mail_message_metadata");
    expect(purge).toBeDefined();
    const sql = render((purge as DeleteCall).where);
    expect(sql).toContain('"org_id"');
    expect(sql).toContain('"account_id"');
  });

  it("BITE: deletes the sync checkpoint so no position survives to resume into a mailbox that is gone", async () => {
    const h = makeHarness();
    await h.service.disconnect(ORG, USER, CONNECTION_ID);

    const purge = h.deletes.find((d) => d.table === "mail_sync_checkpoints");
    expect(purge).toBeDefined();
    const sql = render((purge as DeleteCall).where);
    expect(sql).toContain('"org_id"');
    expect(sql).toContain('"account_id"');
  });

  it("BITE: purges inside the same transaction that removes the connection row", async () => {
    const h = makeHarness();
    await h.service.disconnect(ORG, USER, CONNECTION_ID);

    const purged = h.deletes.filter(
      (d) => d.table === "mail_message_metadata" || d.table === "mail_sync_checkpoints",
    );
    expect(purged).toHaveLength(2);
    for (const d of purged) expect(d.insideTransaction).toBe(true);
  });

  it("removes the connection row itself, which is what the purge hangs off", async () => {
    const h = makeHarness();
    await h.service.disconnect(ORG, USER, CONNECTION_ID);

    expect(h.deletes.map((d) => d.table)).toContain("user_integration_connections");
  });
});
