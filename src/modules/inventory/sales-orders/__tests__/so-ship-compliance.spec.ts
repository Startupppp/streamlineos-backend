import { SoFulfillmentService } from "../so-fulfillment.service";
import { postShipment } from "../so-ship";
import { runIdempotent } from "../../stock-engine/idempotency";
import type { InvSettingsRow } from "../../stock-engine/stock-engine.types";

/**
 * E5 — the shipment seam, which is what was missing.
 *
 * `IndiaComplianceService` and its adapter were built and wired to nothing: the
 * flags existed, the tables existed, the events were routed, and no code path in
 * the product ever asked for a document. These tests are about the call site,
 * and they pin the three claims E5's "done when" makes:
 *
 *   1. flag off  → **no outbound call at all**, not a call whose result is
 *                  discarded;
 *   2. flag on   → the shipment stores an IRN and the event is emitted (the
 *                  storing and emitting live in `IndiaComplianceService`, which
 *                  has its own tests; what is asserted here is that it is
 *                  reached, with the shipment as the document);
 *   3. either way → the ledger work is identical.
 *
 * The ship transaction's body is faked, so nothing here proves `postShipment`
 * is right — it has its own tests. What is proved is that the compliance call
 * sits *outside* that body and cannot change what it does.
 */

jest.mock("../so-ship", () => {
  const actual = jest.requireActual("../so-ship");
  return {
    ...actual,
    postShipment: jest.fn().mockResolvedValue({
      shipmentId: 77,
      shipmentNumber: "SHIP-00077",
      status: "SHIPPED",
      isPartial: false,
    }),
  };
});

jest.mock("../../stock-engine/idempotency", () => ({
  ...jest.requireActual("../../stock-engine/idempotency"),
  runIdempotent: jest.fn(),
}));

const postShipmentMock = postShipment as jest.MockedFunction<typeof postShipment>;
const runIdempotentMock = runIdempotent as jest.MockedFunction<typeof runIdempotent>;

const ORG = "org-1";
const USER = "u-1";
const SO_ID = 12;

function settings(overrides: Partial<InvSettingsRow> = {}): InvSettingsRow {
  return {
    allowNegativeStock: false,
    allowBackorders: false,
    reservationStrategy: "AUTO_ON_CONFIRM",
    defaultCostingMethod: "WEIGHTED_AVERAGE",
    expiryReservationPolicy: "BLOCK",
    inspectionOnReceipt: false,
    inspectionOnReturn: false,
    overReceiptTolerancePct: "0.00",
    requirePoApproval: false,
    adjustmentApprovalThreshold: null,
    autoReserveOnConfirm: true,
    allowPartialShipment: true,
    packageRequiredForShipping: false,
    channelPublishPolicy: null,
    packs: { warehouse: true, kirana: false, pharmacy: false, gst: true, quickCommerce: false, materials: false },
    pharmacyH1RegisterEnabled: false,
    qcZeptoEmailPoEnabled: false,
    asnRequiredForGrn: false,
    wavelessPicking: false,
    wavelessMaxLines: 50,
    gstMode: "REGULAR",
    nearExpiryPolicy: "DEPRIORITIZE",
    nearExpiryWindowDays: 30,
    gstEinvoiceEnabled: false,
    gstEwaybillEnabled: false,
    tallyExportEnabled: false,
    complianceAdapter: "stub",
    ...overrides,
  };
}

interface Harness {
  service: SoFulfillmentService;
  register: jest.Mock;
  shipmentLineSelects: number;
}

function makeService(settingsRow: InvSettingsRow): Harness {
  const state = { shipmentLineSelects: 0 };

  const shipmentLines = [
    { name: "Blue Widget", sku: "SKU-A", hsnCode: "8471", quantity: "3.0000", unitPrice: "100.0000" },
  ];

  const db = {
    // The callback IS invoked — a bare `jest.fn()` here would silently void
    // every assertion inside the transaction (backend/CLAUDE.md §8). The body it
    // runs is `runIdempotent`, mocked to call its work function, which is
    // `postShipment`, mocked to return a canned shipment.
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    select: jest.fn().mockImplementation(() => {
      state.shipmentLineSelects += 1;
      return {
        from: () => ({
          innerJoin: () => ({
            leftJoin: () => ({ where: () => Promise.resolve(shipmentLines) }),
          }),
        }),
      };
    }),
  };

  const register = jest.fn().mockResolvedValue({
    status: "REGISTERED",
    externalId: "STUB-EINVOICE-ABC",
    isLive: false,
  });

  const service = new SoFulfillmentService(
    db as never,
    { del: jest.fn(), invalidateNamespace: jest.fn() } as never,
    { invalidateCaches: jest.fn() } as never,
    {} as never,
    // NEO-1's channel pools. This spec drives `postShipment` through a mock, so
    // the pool draw-down never runs here — it is asserted in the pool spec and
    // in the seeded golden path.
    {} as never,
    { get: jest.fn().mockResolvedValue(settingsRow) } as never,
    {} as never,
    { postJournalEntry: jest.fn() } as never,
    {} as never,
    {} as never,
    { register } as never,
  );

  return { service, register, get shipmentLineSelects() { return state.shipmentLineSelects; } };
}

beforeEach(() => {
  jest.clearAllMocks();
  postShipmentMock.mockResolvedValue({
    shipmentId: 77,
    shipmentNumber: "SHIP-00077",
    status: "SHIPPED",
    isPartial: false,
  });
  runIdempotentMock.mockImplementation(
    (_tx: unknown, _orgId: string, _key: string, _request: unknown, work: () => Promise<unknown>) =>
      work() as never,
  );
});

const SHIP_INPUT = { shipDate: "2026-08-29" } as never;

describe("E5 — with the flags off, nothing statutory happens", () => {
  it("makes no provider call", async () => {
    const { service, register } = makeService(settings());

    await service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);

    expect(register).not.toHaveBeenCalled();
  });

  it("builds no payload — it does not even read the shipment's lines", async () => {
    // The distinction E5 draws: "off" is not "call the provider and discard the
    // answer", and it is not "assemble a document nobody sends" either. Nothing
    // is constructed, so there is nothing to leak and nothing to clean up if the
    // flag is turned on months later.
    const harness = makeService(settings());

    await harness.service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);

    expect(harness.shipmentLineSelects).toBe(0);
  });

  it("makes no provider call when the gst pack is off, whatever the flags say", async () => {
    // Without the pack no line carries an HSN code, so there is nothing that
    // could be described to a tax authority. A flag on top of a missing pack is
    // a misconfiguration, not an instruction.
    const { service, register } = makeService(
      settings({
        packs: { warehouse: true, kirana: false, pharmacy: false, gst: false, quickCommerce: false, materials: false },
        gstEinvoiceEnabled: true,
        gstEwaybillEnabled: true,
      }),
    );

    await service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);

    expect(register).not.toHaveBeenCalled();
  });
});

describe("E5 — with the flag on, the shipment is filed", () => {
  it("registers an e-invoice against the shipment that just posted", async () => {
    const { service, register } = makeService(settings({ gstEinvoiceEnabled: true }));

    await service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);

    expect(register).toHaveBeenCalledTimes(1);
    const [orgId, userId, request] = register.mock.calls[0] as [
      string,
      string,
      { kind: string; sourceType: string; sourceId: string; documentNumber: string; lines: unknown[] },
    ];
    expect(orgId).toBe(ORG);
    expect(userId).toBe(USER);
    expect(request.kind).toBe("EINVOICE");
    // The shipment, not the order: an e-way bill describes goods on a vehicle,
    // and a partially shipped order raises one document per dispatch.
    expect(request.sourceType).toBe("inv_shipment");
    expect(request.sourceId).toBe("77");
    expect(request.documentNumber).toBe("SHIP-00077");
  });

  it("sends the shipped quantity and its taxable value as decimal strings", async () => {
    const { service, register } = makeService(settings({ gstEinvoiceEnabled: true }));

    await service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);

    const [, , request] = register.mock.calls[0] as [
      string,
      string,
      { lines: Array<{ description: string; hsnCode: string | null; quantity: string; taxableValue: string }> },
    ];
    expect(request.lines).toEqual([
      {
        description: "SKU-A Blue Widget",
        hsnCode: "8471",
        quantity: "3.0000",
        taxableValue: "300.0000",
      },
    ]);
  });

  it("raises an e-way bill and an e-invoice independently, on their own flags", async () => {
    const both = makeService(settings({ gstEinvoiceEnabled: true, gstEwaybillEnabled: true }));
    await both.service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);
    expect(both.register.mock.calls.map((c) => (c[2] as { kind: string }).kind)).toEqual([
      "EINVOICE",
      "EWAYBILL",
    ]);

    jest.clearAllMocks();
    const ewayOnly = makeService(settings({ gstEwaybillEnabled: true }));
    await ewayOnly.service.shipSo(ORG, SO_ID, USER, "key-2", SHIP_INPUT);
    expect(ewayOnly.register.mock.calls.map((c) => (c[2] as { kind: string }).kind)).toEqual([
      "EWAYBILL",
    ]);
  });

  it("does not fail the shipment when the provider refuses", async () => {
    // The goods have left the building and the stock has moved. An IRP being
    // down is not a reason to unwind a dispatch that physically happened, and
    // throwing here would invite exactly that.
    const { service, register } = makeService(settings({ gstEinvoiceEnabled: true }));
    register.mockResolvedValue({ status: "FAILED", code: "2150", message: "Duplicate IRN" });

    await expect(service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT)).resolves.toMatchObject({
      shipmentId: 77,
      status: "SHIPPED",
    });
  });

  it("does not fail the shipment when the compliance service throws", async () => {
    const { service, register } = makeService(settings({ gstEinvoiceEnabled: true }));
    register.mockRejectedValue(new Error("connection reset"));

    await expect(service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT)).resolves.toMatchObject({
      shipmentId: 77,
    });
  });
});

describe("E5 — the adapter does not touch the ledger", () => {
  it("posts identical stock work with the flags on and with them off", async () => {
    // `postShipment` is the only thing in this command that writes the ledger.
    // If the compliance call could change what the ledger records, it would show
    // up as a different argument here — and if it were inside the ship
    // transaction at all, it would run before the `outgoing_qty` recompute that
    // must stay last.
    const off = makeService(settings());
    await off.service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);
    const argsWithFlagOff = postShipmentMock.mock.calls[0]?.[2];

    jest.clearAllMocks();
    postShipmentMock.mockResolvedValue({
      shipmentId: 77,
      shipmentNumber: "SHIP-00077",
      status: "SHIPPED",
      isPartial: false,
    });
    runIdempotentMock.mockImplementation(
      (_tx: unknown, _orgId: string, _key: string, _request: unknown, work: () => Promise<unknown>) =>
        work() as never,
    );

    const on = makeService(settings({ gstEinvoiceEnabled: true, gstEwaybillEnabled: true }));
    await on.service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);
    const argsWithFlagOn = postShipmentMock.mock.calls[0]?.[2];

    expect(on.register).toHaveBeenCalled();

    // The compliance flags travel on the same settings row, so the rows are not
    // identical — and comparing them whole would only assert that. What has to
    // be identical is everything the ledger is posted from: the order, the
    // actor, the idempotency key, the request, and the two settings
    // `postShipment` actually consults (`ShipSettings`). If a flag could reach
    // any of these, it could change what the ledger records.
    const { settings: settingsOff, ...ledgerInputsOff } = argsWithFlagOff!;
    const { settings: settingsOn, ...ledgerInputsOn } = argsWithFlagOn!;

    expect(ledgerInputsOn).toEqual(ledgerInputsOff);
    expect({
      packageRequiredForShipping: settingsOn.packageRequiredForShipping,
      allowPartialShipment: settingsOn.allowPartialShipment,
    }).toEqual({
      packageRequiredForShipping: settingsOff.packageRequiredForShipping,
      allowPartialShipment: settingsOff.allowPartialShipment,
    });
  });

  it("calls the provider only after the ship transaction has committed", async () => {
    // Ordering, asserted rather than assumed. Inside the transaction this would
    // hold a pooled connection with a tenant GUC on it for the length of a
    // provider's outage (§4), and it would land after the `outgoing_qty`
    // recompute that has to be the transaction's last write.
    const order: string[] = [];
    const { service, register } = makeService(settings({ gstEinvoiceEnabled: true }));
    postShipmentMock.mockImplementation(async () => {
      order.push("ledger");
      return { shipmentId: 77, shipmentNumber: "SHIP-00077", status: "SHIPPED" as const, isPartial: false };
    });
    register.mockImplementation(() => {
      order.push("compliance");
      return Promise.resolve({ status: "REGISTERED", externalId: "STUB-1", isLive: false });
    });

    await service.shipSo(ORG, SO_ID, USER, "key-1", SHIP_INPUT);

    expect(order).toEqual(["ledger", "compliance"]);
  });
});
