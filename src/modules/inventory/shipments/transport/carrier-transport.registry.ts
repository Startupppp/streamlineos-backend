import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { ReferenceHttpCarrierAdapter } from "./reference-http.adapter";
import { DelhiveryHttpCarrierAdapter } from "./delhivery-http.adapter";
import type { CarrierTransportAdapter } from "./carrier-transport.port";

/**
 * INV-26 — which adapter speaks for a carrier row.
 *
 * Resolution is by `inv_carriers.transport`, **not** by `code`. That is the
 * whole reason the column exists: `code` is the tenant's own string, so
 * resolving on it would mean an organisation that names its courier "FEDEX"
 * acquires a FedEx integration by typing. `transport` is written by an
 * administrator, validated against `knownTransports()` at the boundary, and an
 * unrecognised value resolves to `null` rather than throwing — a row whose
 * adapter was retired must degrade to manual tracking, not 500 every screen
 * that lists carriers.
 *
 * Registration is the deliberate act. An adapter exists because this file names
 * it, never because a row said so.
 *
 * Unlike `ComplianceTransportRegistry`, this does not refuse a non-real adapter
 * at boot, and the asymmetry is the point. That registry refuses because a mock
 * IRP fabricates an acknowledgement — synthetic evidence of a statutory filing,
 * which is worse than a failed deploy. Nothing here fabricates: the reference
 * adapter makes real HTTP calls and reports exactly what came back, so the
 * worst a misconfigured production node does is record a carrier that refuses
 * every booking, which is visible in `inv_carrier_operations` and harms nothing.
 * Refusing to boot over it would be a cost with no matching risk.
 */
@Injectable()
export class CarrierTransportRegistry implements OnModuleInit {
  private readonly logger = new Logger(CarrierTransportRegistry.name);
  private readonly adapters = new Map<string, CarrierTransportAdapter>();

  constructor(
    @Optional() reference?: ReferenceHttpCarrierAdapter,
    @Optional() delhivery?: DelhiveryHttpCarrierAdapter,
  ) {
    if (reference) this.register(reference);
    if (delhivery) this.register(delhivery);
  }

  onModuleInit(): void {
    for (const adapter of this.adapters.values()) {
      this.logger.log(
        `Carrier transport "${adapter.transport}": ${adapter.name}` +
          (adapter.isReal ? "" : " — speaks this repository's own JSON shape, not a courier's"),
      );
    }
  }

  /** The adapter for a carrier row, or null when the row names none. */
  forTransport(transport: string | null | undefined): CarrierTransportAdapter | null {
    if (!transport) return null;
    return this.adapters.get(transport.trim().toLowerCase()) ?? null;
  }

  /** What an administrator may put in `inv_carriers.transport`. */
  knownTransports(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }

  /**
   * What a screen should say about a carrier's connection. Separated from
   * `forTransport` so an honest empty state does not have to know what an
   * adapter is.
   */
  describe(transport: string | null | undefined): {
    connected: boolean;
    real: boolean;
    name: string;
  } {
    const adapter = this.forTransport(transport);
    if (!adapter) {
      return {
        connected: false,
        real: false,
        name: "No carrier connection. Tracking numbers are whatever an operator enters.",
      };
    }
    return { connected: true, real: adapter.isReal, name: adapter.name };
  }

  /** Used by the adapter tests, and by whichever real courier ships first. */
  register(adapter: CarrierTransportAdapter): void {
    this.adapters.set(adapter.transport.trim().toLowerCase(), adapter);
  }
}
