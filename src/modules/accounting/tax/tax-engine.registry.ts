import { Injectable, Optional } from "@nestjs/common";
import { GenericVatEngine, StubTaxEngine } from "./engines/generic-vat.engine";
import { InGstEngine } from "./engines/in-gst.engine";
import type { TaxEngine } from "./tax.types";

export class TaxEngineNotRegisteredError extends Error {
  constructor(pack: string) {
    super(`No tax engine is registered for pack ${pack}`);
    this.name = "TaxEngineNotRegisteredError";
  }
}

/**
 * The one lookup from pack code to engine.
 *
 * Every jurisdiction is present — the ones without an implementation resolve to
 * a stub that errors rather than to `undefined`, so a missing pack surfaces as
 * "not configured" at determination time instead of as a crash or, worse, as
 * zero tax.
 */
@Injectable()
export class TaxEngineRegistry {
  private readonly engines = new Map<string, TaxEngine>();

  /**
   * `@Optional()` because Nest cannot resolve a bare array type. Production
   * gets the built-in engines; tests pass their own list positionally.
   */
  constructor(@Optional() engines?: readonly TaxEngine[]) {
    const defaults: readonly TaxEngine[] = engines ?? [
      new InGstEngine(),
      new GenericVatEngine(),
      new StubTaxEngine("US", "United States sales tax"),
      new StubTaxEngine("GB", "UK VAT"),
      new StubTaxEngine("EU", "EU VAT"),
      new StubTaxEngine("SG", "Singapore GST"),
      new StubTaxEngine("AU", "Australia GST"),
      new StubTaxEngine("CA", "Canada GST/HST"),
      new StubTaxEngine("AE", "GCC VAT"),
    ];
    for (const engine of defaults) this.engines.set(engine.pack, engine);
  }

  get(pack: string): TaxEngine {
    const engine = this.engines.get(pack);
    if (!engine) throw new TaxEngineNotRegisteredError(pack);
    return engine;
  }

  has(pack: string): boolean {
    return this.engines.has(pack);
  }

  list(): Array<{ pack: string; status: "enabled" | "stub" }> {
    return [...this.engines.values()].map((e) => ({ pack: e.pack, status: e.status }));
  }
}
