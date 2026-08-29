import {
  InvAdjustmentApprovalConsumerService,
  InvLotExpiringConsumerService,
  InvRecallOpenedConsumerService,
} from "../inv-notification-consumers.service";
import { NOTIFICATION_EVENT_MAP } from "../../../notifications/notification-events.catalog";

/**
 * G3 — the four triggers, and the two properties that make them usable.
 *
 * A notification system fails in two directions and only one of them is loud.
 * The loud one is not notifying: nobody hears about the recall. The quiet one is
 * notifying too much, and it is worse, because the operator mutes the category
 * and then does not hear about the recall either. Both are asserted here.
 */

interface Claimed {
  consumer: string;
  eventId: string;
}

function buildHarness(opts: { members?: string[]; alreadyClaimed?: boolean } = {}) {
  const claims: Claimed[] = [];
  const processed: Array<{ status: string; detail: string | null }> = [];
  const dispatched: Array<Record<string, unknown>> = [];

  jest
    .spyOn(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../../../common/outbox/inbox-consumer") as {
        InboxConsumer: new (db: unknown) => unknown;
      },
      "InboxConsumer",
    )
    .mockImplementation(
      () =>
        ({
          claim: async (consumer: string, e: { eventId: string }) => {
            claims.push({ consumer, eventId: e.eventId });
            return !opts.alreadyClaimed;
          },
          markProcessed: async (
            _c: string,
            _e: string,
            status: string,
            detail: string | null,
          ) => {
            processed.push({ status, detail });
          },
        }) as never,
    );

  const dispatch = {
    emit: async (input: Record<string, unknown>) => {
      dispatched.push(input);
      return { eventKey: String(input.eventKey), notified: 1, deliveriesQueued: 1 };
    },
  };
  const registry = { register: jest.fn() };
  const access = {
    membersWithPermission: async () =>
      (opts.members ?? ["approver-1", "approver-2"]).map((userId) => ({ userId })),
  };

  return { claims, processed, dispatched, dispatch, registry, access };
}

function event(payload: unknown, eventId = "evt-1") {
  return {
    eventId,
    organizationId: "org-1",
    aggregateType: "inv_lot",
    aggregateId: "1",
    aggregateVersion: 1,
    payload,
  } as never;
}

afterEach(() => jest.restoreAllMocks());

describe("G3 inventory notification consumers", () => {
  describe("the catalog knows every key a consumer dispatches", () => {
    it.each([
      "inventory.stock.low",
      "inventory.lot.expiring",
      "inventory.adjustment.approval_requested",
      "inventory.recall.opened",
    ])("%s is a registered event", (key) => {
      expect(NOTIFICATION_EVENT_MAP.has(key)).toBe(true);
    });
  });

  describe("lot nearing expiry", () => {
    it("dedupes on the lot and the window, not the sweep run", async () => {
      const h = buildHarness();
      const service = new InvLotExpiringConsumerService(
        {} as never,
        h.dispatch as never,
        h.registry as never,
        h.access as never,
      );

      const payload = {
        lotId: 77,
        lotNumber: "L-77",
        productVariantId: 5,
        expiryDate: "2026-10-01",
        windowDays: 30,
        onHand: "12.0000",
      };
      await service.handle(event(payload, "evt-a"));
      await service.handle(event(payload, "evt-b"));

      // Two sweeps, two outbox events, one subject — so one dedupe key. The
      // uniqueness on (org_id, dedupe_key) is what collapses them; this asserts
      // the consumer hands over a key that can collapse.
      expect(h.dispatched).toHaveLength(2);
      expect(h.dispatched[0]!.dedupeKey).toBe("lot-expiring:77:30");
      expect(h.dispatched[1]!.dedupeKey).toBe(h.dispatched[0]!.dedupeKey);
    });

    it("gives a different key once the lot crosses the next window", async () => {
      const h = buildHarness();
      const service = new InvLotExpiringConsumerService(
        {} as never,
        h.dispatch as never,
        h.registry as never,
        h.access as never,
      );
      const base = {
        lotId: 77,
        lotNumber: "L-77",
        productVariantId: 5,
        expiryDate: "2026-10-01",
        onHand: "12.0000",
      };
      await service.handle(event({ ...base, windowDays: 90 }, "evt-90"));
      await service.handle(event({ ...base, windowDays: 60 }, "evt-60"));

      expect(h.dispatched.map((d) => d.dedupeKey)).toEqual([
        "lot-expiring:77:90",
        "lot-expiring:77:60",
      ]);
    });

    it("skips a malformed payload rather than crashing the relay behind it", async () => {
      const h = buildHarness();
      const service = new InvLotExpiringConsumerService(
        {} as never,
        h.dispatch as never,
        h.registry as never,
        h.access as never,
      );

      await expect(service.handle(event({ lotId: "not a number" }))).resolves.toBeUndefined();
      expect(h.dispatched).toHaveLength(0);
      expect(h.processed[0]!.status).toBe("FAILED");
    });

    it("does nothing at all when the inbox says the event is already handled", async () => {
      const h = buildHarness({ alreadyClaimed: true });
      const service = new InvLotExpiringConsumerService(
        {} as never,
        h.dispatch as never,
        h.registry as never,
        h.access as never,
      );
      await service.handle(
        event({
          lotId: 1,
          lotNumber: "L",
          productVariantId: 1,
          expiryDate: "2026-10-01",
          windowDays: 30,
          onHand: "1.0000",
        }),
      );
      expect(h.dispatched).toHaveLength(0);
      expect(h.processed).toHaveLength(0);
    });
  });

  describe("adjustment awaiting approval", () => {
    it("notifies the approvers and not the person who raised it", async () => {
      const h = buildHarness({ members: ["approver-1", "raiser", "approver-2"] });
      const service = new InvAdjustmentApprovalConsumerService(
        {} as never,
        h.dispatch as never,
        h.registry as never,
        h.access as never,
      );

      await service.handle(
        event({
          adjustmentId: 42,
          referenceNumber: "ADJ-42",
          reason: "DAMAGE",
          lineCount: 2,
          requestedByUserId: "raiser",
        }),
      );

      expect(h.dispatched[0]!.targetUserIds).toEqual(["approver-1", "approver-2"]);
      expect(h.dispatched[0]!.dedupeKey).toBe("adjustment-approval:42");
    });

    it("skips when the organisation has nobody who may approve", async () => {
      const h = buildHarness({ members: [] });
      const service = new InvAdjustmentApprovalConsumerService(
        {} as never,
        h.dispatch as never,
        h.registry as never,
        h.access as never,
      );
      await service.handle(
        event({
          adjustmentId: 42,
          referenceNumber: "ADJ-42",
          reason: "DAMAGE",
          lineCount: 1,
          requestedByUserId: "raiser",
        }),
      );
      expect(h.dispatched).toHaveLength(0);
      expect(h.processed[0]).toEqual({ status: "SKIPPED", detail: "no recipients" });
    });
  });

  describe("recall opened", () => {
    it("dispatches once per recall, to everyone who can read quality", async () => {
      const h = buildHarness({ members: ["ops", "qa"] });
      const service = new InvRecallOpenedConsumerService(
        {} as never,
        h.dispatch as never,
        h.registry as never,
        h.access as never,
      );

      await service.handle(
        event({
          recallId: 9,
          referenceNumber: "RCL-9",
          title: "Contaminated batch",
          lotCount: 3,
          quarantinedGrains: 5,
          openedByUserId: "qa",
        }),
      );

      expect(h.dispatched).toHaveLength(1);
      expect(h.dispatched[0]!.eventKey).toBe("inventory.recall.opened");
      expect(h.dispatched[0]!.dedupeKey).toBe("recall-opened:9");
      // The person who opened it is NOT excluded here, deliberately: a recall is
      // the one event where the opener wants the same confirmation everybody else
      // gets, and being told your own recall is live is not noise.
      expect(h.dispatched[0]!.targetUserIds).toEqual(["ops", "qa"]);
    });
  });
});
