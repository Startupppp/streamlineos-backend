jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../../db/drizzle.types";
import type { GmailMailProvider } from "../../mail/providers/gmail-mail.provider";
import type { OutlookMailProvider } from "../../mail/providers/outlook-mail.provider";
import type { InboundIngressService } from "../inbound-ingress.service";
import { getTenantContext } from "../../../common/tenant/tenant-context";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import { CrmMailboxService } from "./crm-mailbox.service";

interface Trace {
  transactions: number;
  organizationIdPerTransaction: (string | undefined)[];
  contextDuringFetch: unknown;
}

function tracingDb(trace: Trace, row: Record<string, unknown>): Db {
  let selectCall = 0;

  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      selectCall += 1;
      if (selectCall === 1) return [row];
      return [{ userId: "user-1", composioAccountId: "acct-1", status: "active" }];
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      const found = /set_config\('app\.organization_id', "\]\},"([^"]+)"/.exec(text);
      trace.organizationIdPerTransaction.push(found?.[1]);
      return [];
    },
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      trace.transactions += 1;
      return run(chain);
    },
  };

  return chain as unknown as Db;
}

function serviceThatRecordsContext(trace: Trace) {
  const db = tracingDb(trace, {
    crmMailboxSyncId: "mailbox-1",
    organizationId: "org-1",
    connectionId: 7,
    mailboxAddress: "rep@ourcompany.example",
    provider: "gmail",
    syncedThrough: null,
    enabled: true,
    consecutiveFailures: 0,
  });

  const gmail = {
    listMessages: async () => {
      trace.contextDuringFetch = getTenantContext();
      return { messages: [], nextPageToken: null };
    },
  } as unknown as GmailMailProvider;

  const ingress = { accept: async () => ({ status: "accepted" }) } as unknown as InboundIngressService;
  const outlook = { listMessages: async () => ({ messages: [], nextSkip: null }) } as unknown as OutlookMailProvider;

  return new CrmMailboxService(db, ingress, gmail, outlook);
}

/**
 * A mailbox sweep reads Gmail or Outlook over the network. While it did that
 * inside the request transaction, one `POST /crm-mailbox/sync` occupied a tenth
 * of an instance's pool for the length of a provider round trip — and
 * `sweepAll` did it once per mailbox, up to fifty times, on a single borrowed
 * connection.
 */
describe("the CRM mailbox sweep and the request transaction", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("calls the mail provider with no tenant context, so no connection is held across the network", async () => {
    const trace: Trace = {
      transactions: 0,
      organizationIdPerTransaction: [],
      contextDuringFetch: "never ran",
    };

    await serviceThatRecordsContext(trace).sync("org-1", "mailbox-1");

    expect(trace.contextDuringFetch).toBeUndefined();
  });

  it("opens one transaction to decide and another to record, never one spanning the fetch", async () => {
    const trace: Trace = {
      transactions: 0,
      organizationIdPerTransaction: [],
      contextDuringFetch: "never ran",
    };

    await serviceThatRecordsContext(trace).sync("org-1", "mailbox-1");

    expect(trace.transactions).toBe(2);
  });

  it("sets the tenant GUC in every transaction it opens, so no statement runs unscoped", async () => {
    const trace: Trace = {
      transactions: 0,
      organizationIdPerTransaction: [],
      contextDuringFetch: "never ran",
    };

    await serviceThatRecordsContext(trace).sync("org-1", "mailbox-1");

    expect(trace.organizationIdPerTransaction).toHaveLength(trace.transactions);
    for (const orgId of trace.organizationIdPerTransaction) expect(orgId).toBe("org-1");
  });

  it("lists the mailboxes to sweep inside a tenant transaction, because POST /crm-mailbox/sync carries no request transaction and crm_mailbox_sync's policy raises 42501 without the GUC", async () => {
    let orgAtListing: unknown = "never ran";
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => {
        orgAtListing = getTenantContext()?.orgId;
        return [];
      },
      execute: async () => [],
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run(chain),
    };
    const service = new CrmMailboxService(
      chain as unknown as Db,
      {} as unknown as InboundIngressService,
      {} as unknown as GmailMailProvider,
      {} as unknown as OutlookMailProvider,
    );

    await expect(service.sweepAll("org-1")).resolves.toEqual({ mailboxes: 0, swept: 0, delivered: 0 });
    expect(orgAtListing).toBe("org-1");
  });
});
