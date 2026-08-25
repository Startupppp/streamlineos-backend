// The gateway reaches the Composio SDK, which ships ESM that jest does not
// transform. Mocked at the door, exactly as `crm-mailbox.service.spec` does —
// this substitutes a module loader, not a provider. Nothing below stubs a
// carrier's behaviour; the payloads all come from the fixture.
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../../db/drizzle.types";
import type { ComposioGateway } from "../../integrations/core/composio.gateway";
import type { InboundCommunicationEvent } from "../inbound-event";
import type { InboundIngressService } from "../inbound-ingress.service";
import { INITIAL_LOOKBACK_MS, OVERLAP_MS } from "./mailbox-sync";
import { TelephonyCallLogService } from "./telephony-call-log.service";
import {
  CALL_LOG_ERROR_PAYLOAD,
  CALL_LOG_PAGE_ONE,
  CALL_LOG_PAGE_TWO,
} from "./telephony-call-log.spec-fixtures";

/**
 * The sweep as its caller meets it.
 *
 * Two things are on trial here and neither is arithmetic. The first is that
 * connectivity goes out through Composio and `user_integration_connections` and
 * nowhere else — the database double below has no `insert` and no `update`, so
 * any attempt to write a provider credential anywhere would throw rather than
 * pass. The second is that a sweep which reads calls and files none of them says
 * so, because a channel reporting itself healthy while delivering nothing is the
 * worst failure available to it.
 */

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const ORG = "org-1";
const CONNECTION_ID = 7;

interface ConnectionRow {
  userId: string;
  toolkit: string;
  composioAccountId: string;
  accountLabel: string | null;
  accountEmail: string | null;
  status: string;
}

const connection = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  userId: "user-1",
  toolkit: "twilio",
  composioAccountId: "conn-acct-1",
  accountLabel: "AC00000000000000000000000000000000",
  accountEmail: null,
  status: "active",
  ...over,
});

/**
 * Answers the two reads the sweep makes, told apart by how they are asked.
 *
 * The connection is `where().limit()`; the watermark is `where().orderBy().limit()`.
 * No `insert`, no `update` — see this file's docblock.
 */
function makeDb(row: ConnectionRow | null, watermark: Date | null): Db {
  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => ({
          limit: jest.fn().mockImplementation(async () => (row ? [row] : [])),
          orderBy: jest.fn().mockImplementation(() => ({
            limit: jest
              .fn()
              .mockImplementation(async () => (watermark ? [{ occurredAt: watermark }] : [])),
          })),
        })),
      })),
    })),
  } as unknown as Db;
}

interface ProxyStub {
  gateway: ComposioGateway;
  calls: { accountId: string; method: string; endpoint: string }[];
}

/** Composio's HTTP proxy, answering with the fixture pages in order. */
function makeComposio(pages: unknown[]): ProxyStub {
  const calls: ProxyStub["calls"] = [];
  let page = 0;

  const gateway = {
    executeProxy: jest
      .fn()
      .mockImplementation(async (accountId: string, method: string, endpoint: string) => {
        calls.push({ accountId, method, endpoint });
        return pages[Math.min(page++, pages.length - 1)];
      }),
  } as unknown as ComposioGateway;

  return { gateway, calls };
}

interface IngressStub {
  ingress: InboundIngressService;
  accepted: InboundCommunicationEvent[];
}

function makeIngress(): IngressStub {
  const accepted: InboundCommunicationEvent[] = [];
  const ingress = {
    accept: jest.fn().mockImplementation(async (event: InboundCommunicationEvent) => {
      accepted.push(event);
      return { status: "accepted", inboundEventId: `ev-${accepted.length}`, workflowRunId: null };
    }),
  } as unknown as InboundIngressService;

  return { ingress, accepted };
}

function makeService(
  row: ConnectionRow | null,
  watermark: Date | null,
  pages: unknown[],
): { service: TelephonyCallLogService; proxy: ProxyStub; ingress: IngressStub } {
  const proxy = makeComposio(pages);
  const ingress = makeIngress();
  const service = new TelephonyCallLogService(makeDb(row, watermark), proxy.gateway, ingress.ingress);
  return { service, proxy, ingress };
}

describe("TelephonyCallLogService", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("what it refuses to sweep at all", () => {
    it("treats a connection that is not there as a disconnected carrier", async () => {
      const { service, proxy } = makeService(null, null, [CALL_LOG_PAGE_ONE]);
      await expect(service.sync(ORG, CONNECTION_ID)).resolves.toMatchObject({
        swept: false,
        reason: "disconnected",
      });
      expect(proxy.calls).toHaveLength(0);
    });

    /**
     * A Gmail connection id handed to this method must not become a request for
     * somebody's call log. The toolkit column is plain text and the union it
     * wears has no carrier in it, so this check is the only thing standing there.
     */
    it("refuses a connection belonging to another toolkit", async () => {
      const { service, proxy } = makeService(connection({ toolkit: "gmail" }), null, [
        CALL_LOG_PAGE_ONE,
      ]);
      await expect(service.sync(ORG, CONNECTION_ID)).resolves.toMatchObject({
        swept: false,
        reason: "not-telephony",
      });
      expect(proxy.calls).toHaveLength(0);
    });

    it("skips a connection awaiting re-authorisation rather than failing it", async () => {
      const { service } = makeService(connection({ status: "needs_reauth" }), null, [
        CALL_LOG_PAGE_ONE,
      ]);
      await expect(service.sync(ORG, CONNECTION_ID)).resolves.toMatchObject({
        swept: false,
        reason: "needs-reauth",
      });
    });

    /** The account reference is a path segment in every request; an empty one is a request for nothing. */
    it("refuses a connection with no carrier account on it", async () => {
      const { service, proxy } = makeService(
        connection({ accountLabel: null, accountEmail: null }),
        null,
        [CALL_LOG_PAGE_ONE],
      );
      await expect(service.sync(ORG, CONNECTION_ID)).resolves.toMatchObject({
        swept: false,
        reason: "no-account-reference",
      });
      expect(proxy.calls).toHaveLength(0);
    });
  });

  describe("connectivity", () => {
    it("goes out through Composio's proxy, on the account the connection names", async () => {
      const { service, proxy } = makeService(connection(), null, [CALL_LOG_PAGE_TWO]);
      await service.sync(ORG, CONNECTION_ID);

      expect(proxy.calls[0]).toEqual({
        accountId: "conn-acct-1",
        method: "GET",
        endpoint: "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json",
      });
    });

    /**
     * Every page after the first is the URI the provider handed back, never one
     * assembled here — the only string this module invents is the first path,
     * where being wrong is a 404 rather than a filter silently ignored.
     */
    it("follows the provider's own next-page uri", async () => {
      const { service, proxy } = makeService(connection(), null, [
        CALL_LOG_PAGE_ONE,
        CALL_LOG_PAGE_TWO,
      ]);
      await service.sync(ORG, CONNECTION_ID);

      expect(proxy.calls).toHaveLength(2);
      expect(proxy.calls[1]?.endpoint).toBe(
        "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json?Page=1&PageToken=PAxyz",
      );
    });
  });

  describe("a first sweep", () => {
    it("offers every inbound call in the window to the seam", async () => {
      const { service, ingress } = makeService(connection(), null, [
        CALL_LOG_PAGE_ONE,
        CALL_LOG_PAGE_TWO,
      ]);
      const result = await service.sync(ORG, CONNECTION_ID);

      expect(result).toMatchObject({ swept: true, read: 7, delivered: 3 });
      expect(ingress.accepted.map((event) => event.providerMessageId)).toEqual([
        "CA0000000000000000000000000000001",
        "CA0000000000000000000000000000002",
        "CA0000000000000000000000000000007",
      ]);
    });

    it("counts every refusal by name, so a caller can be told which", async () => {
      const { service } = makeService(connection(), null, [CALL_LOG_PAGE_ONE, CALL_LOG_PAGE_TWO]);
      const result = await service.sync(ORG, CONNECTION_ID);

      expect(result).toMatchObject({
        swept: true,
        skipped: {
          "no-identifier": 0,
          "no-timestamp": 1,
          "direction-unknown": 1,
          "no-counterparty": 1,
          "outbound-unattributable": 1,
        },
      });
    });

    /**
     * The finding, surfaced where somebody can read it. Outbound calls are not a
     * provider fault and no amount of waiting fixes them, so the note says why
     * rather than reporting a number and moving on.
     */
    it("says out loud that the outbound half of the conversation is missing", async () => {
      const { service } = makeService(connection(), null, [CALL_LOG_PAGE_ONE, CALL_LOG_PAGE_TWO]);
      const result = await service.sync(ORG, CONNECTION_ID);

      expect(result.note).toContain("outbound");
      expect(result.note).toContain("resolved from whoever called");
    });

    it("reads back to the initial lookback when the channel has delivered nothing", async () => {
      const { service, ingress } = makeService(connection(), null, [CALL_LOG_PAGE_TWO]);
      await service.sync(ORG, CONNECTION_ID);

      // Page two is a day old and would fall below any tighter floor.
      expect(new Date(NOW - INITIAL_LOOKBACK_MS).getTime()).toBeLessThan(
        Date.parse("Mon, 24 Aug 2026 16:00:00 +0000"),
      );
      expect(ingress.accepted).toHaveLength(1);
    });
  });

  describe("a later sweep", () => {
    /**
     * The watermark is the newest call this organisation has already accepted an
     * event for, so it cannot name a call that was never read. The overlap is why
     * a call landing mid-sweep is offered again rather than lost, and the seam
     * deduplicates it for nothing.
     */
    it("reads from the last call it delivered, less the overlap", async () => {
      const watermark = new Date("2026-08-25T09:45:00.000Z");
      const { service, ingress } = makeService(connection(), watermark, [
        CALL_LOG_PAGE_ONE,
        CALL_LOG_PAGE_TWO,
      ]);
      const result = await service.sync(ORG, CONNECTION_ID);

      expect(new Date(watermark.getTime() - OVERLAP_MS).toISOString()).toBe(
        "2026-08-25T09:40:00.000Z",
      );
      expect(ingress.accepted.map((event) => event.providerMessageId)).toEqual([
        "CA0000000000000000000000000000001",
      ]);
      expect(result).toMatchObject({ swept: true, truncated: false });
    });

    /** Newest first, so the first call below the floor means the rest are too. */
    it("stops at the floor instead of paging through history every few minutes", async () => {
      const { service, proxy } = makeService(connection(), new Date("2026-08-25T09:45:00.000Z"), [
        CALL_LOG_PAGE_ONE,
        CALL_LOG_PAGE_TWO,
      ]);
      await service.sync(ORG, CONNECTION_ID);

      expect(proxy.calls).toHaveLength(1);
    });
  });

  describe("when the provider does not answer with a call log", () => {
    /**
     * The failure this whole shape is built against. A permissive read of a 404
     * body would be "no calls today", and the channel would report itself healthy
     * for as long as nobody checked.
     */
    it("stops the sweep rather than reading an error body as an empty window", async () => {
      const { service, ingress } = makeService(connection(), null, [CALL_LOG_ERROR_PAYLOAD]);
      const result = await service.sync(ORG, CONNECTION_ID);

      expect(result).toMatchObject({ swept: false, reason: "provider-error" });
      expect(ingress.accepted).toHaveLength(0);
    });

    it("explains itself without putting the payload in the message", async () => {
      const { service } = makeService(connection(), null, [CALL_LOG_ERROR_PAYLOAD]);
      const result = await service.sync(ORG, CONNECTION_ID);

      expect(result.note).toContain("nothing has been marked as read");
    });

    it("gives up on a carrier that throws, without taking the other connections with it", async () => {
      const proxy = makeComposio([]);
      proxy.gateway.executeProxy = jest.fn().mockRejectedValue(new Error("connection revoked"));
      const ingress = makeIngress();
      const service = new TelephonyCallLogService(
        makeDb(connection(), null),
        proxy.gateway,
        ingress.ingress,
      );

      await expect(service.sync(ORG, CONNECTION_ID)).resolves.toMatchObject({
        swept: false,
        reason: "provider-error",
        note: "connection revoked",
      });
    });
  });
});
