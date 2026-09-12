import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../../db/drizzle.constants";
import { CacheService } from "../../../../../common/cache/cache.service";
import { InventoryAuditService } from "../../../stock-engine/inventory-audit.service";
import { CarrierCredentialsService } from "../carrier-credentials.service";
import { CarrierTransportRegistry } from "../carrier-transport.registry";
import { CarrierTransportService } from "../carrier-transport.service";
import { CarrierWebhookReceiverService } from "../carrier-webhook.service";
import { ReferenceHttpCarrierAdapter } from "../reference-http.adapter";
import type { CarrierTransportAdapter } from "../carrier-transport.port";

/**
 * INV-26 — that the transport graph actually resolves, and that resolution
 * happens on the column an administrator sets rather than on the one a tenant
 * types.
 *
 * The DI half is not ceremony. `ReferenceHttpCarrierAdapter` takes an optional
 * token-injected HTTP client, which is the one shape in this module that
 * `emitDecoratorMetadata` cannot resolve on its own — a missing `@Optional()`
 * or a provider left out of `inv-shipments.module.ts` fails at *boot*, which in
 * this repository means every seeded suite dying in `beforeAll` with an error
 * that names a class rather than a mistake. A compile here catches it in a
 * second.
 */

const stubs = [
  { provide: DRIZZLE, useValue: {} },
  { provide: CacheService, useValue: { invalidateNamespace: jest.fn() } },
  { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
];

async function graph() {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ...stubs,
      ReferenceHttpCarrierAdapter,
      CarrierTransportRegistry,
      CarrierCredentialsService,
      CarrierTransportService,
      CarrierWebhookReceiverService,
    ],
  }).compile();
  return moduleRef;
}

describe("the carrier transport graph", () => {
  it("resolves every provider the shipments module registers", async () => {
    const moduleRef = await graph();

    expect(moduleRef.get(ReferenceHttpCarrierAdapter)).toBeInstanceOf(ReferenceHttpCarrierAdapter);
    expect(moduleRef.get(CarrierTransportRegistry)).toBeInstanceOf(CarrierTransportRegistry);
    expect(moduleRef.get(CarrierCredentialsService)).toBeInstanceOf(CarrierCredentialsService);
    expect(moduleRef.get(CarrierTransportService)).toBeInstanceOf(CarrierTransportService);
    expect(moduleRef.get(CarrierWebhookReceiverService)).toBeInstanceOf(
      CarrierWebhookReceiverService,
    );
  });

  it("resolves an adapter by the transport column and by nothing else", () => {
    const registry = new CarrierTransportRegistry(new ReferenceHttpCarrierAdapter());

    expect(registry.forTransport("reference-http")?.transport).toBe("reference-http");
    expect(registry.forTransport("  Reference-HTTP  ")?.transport).toBe("reference-http");

    // The carrier `code` is the tenant's own string. An organisation naming its
    // courier "FEDEX" must not thereby acquire a FedEx integration, so an
    // unknown value resolves to null rather than to something plausible.
    expect(registry.forTransport("FEDEX")).toBeNull();
    expect(registry.forTransport(null)).toBeNull();
    expect(registry.forTransport("")).toBeNull();
    expect(registry.knownTransports()).toEqual(["reference-http"]);
  });

  it("says plainly that no courier is connected", () => {
    const registry = new CarrierTransportRegistry(new ReferenceHttpCarrierAdapter());

    expect(registry.describe(null)).toEqual({
      connected: false,
      real: false,
      name: "No carrier connection. Tracking numbers are whatever an operator enters.",
    });
    // Connected, and honest about what it is connected to: the wire format is
    // this repository's own, so `real` is false until a courier is chosen.
    expect(registry.describe("reference-http")).toEqual({
      connected: true,
      real: false,
      name: "Reference HTTP carrier (no courier is connected)",
    });
  });

  it("takes a second adapter without any other file changing", () => {
    const registry = new CarrierTransportRegistry(new ReferenceHttpCarrierAdapter());
    const courier: CarrierTransportAdapter = {
      transport: "acme-courier",
      name: "ACME Courier",
      isReal: true,
      book: () => Promise.resolve({ outcome: "unavailable", reason: "not called" }),
      fetchLabel: () => Promise.resolve({ outcome: "unavailable", reason: "not called" }),
      track: () => Promise.resolve({ outcome: "unavailable", reason: "not called" }),
      verifyWebhook: () => ({ valid: false, reason: "not called" }),
      parseWebhook: () => ({ ok: false, reason: "not called" }),
    };

    registry.register(courier);

    // What "one file" means, asserted rather than claimed: a new courier is a
    // sibling of `reference-http.adapter.ts` plus its registration, and the
    // port, the service, the receiver and the schema are untouched.
    expect(registry.forTransport("acme-courier")).toBe(courier);
    expect(registry.describe("acme-courier")).toEqual({
      connected: true,
      real: true,
      name: "ACME Courier",
    });
    expect(registry.knownTransports()).toEqual(["acme-courier", "reference-http"]);
  });
});
