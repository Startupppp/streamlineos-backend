import { Injectable, Optional } from "@nestjs/common";
import { GenericWhtEngine } from "./generic-wht.engine";
import { IndiaTdsEngine } from "./india-tds.engine";
import type { WithholdingEngine } from "./withholding.types";

/**
 * The one lookup from regime to withholding engine — the sibling of
 * `TaxEngineRegistry`, kept separate on purpose (PRD 10 S3).
 *
 * `forPack` maps a localization pack onto its withholding regime, so
 * `ap-payments.service.ts` asks "which engine does this book use?" rather than
 * branching on a country code. A pack with no dedicated regime falls back to
 * the generic flat-rate engine, which withholds nothing unless a vendor
 * actually carries a code.
 */
@Injectable()
export class WithholdingEngineRegistry {
  private readonly engines = new Map<string, WithholdingEngine>();
  private readonly byPack = new Map<string, string>([["IN", "INDIA_TDS"]]);

  /**
   * `@Optional()` because Nest cannot resolve a bare array type. Production
   * gets the built-in engines; tests pass their own list positionally.
   */
  constructor(@Optional() engines?: readonly WithholdingEngine[]) {
    const defaults: readonly WithholdingEngine[] = engines ?? [
      new IndiaTdsEngine(),
      new GenericWhtEngine(),
    ];
    for (const engine of defaults) this.engines.set(engine.regime, engine);
  }

  get(regime: string): WithholdingEngine {
    return this.engines.get(regime) ?? this.engines.get("GENERIC_WHT")!;
  }

  /** Which regime a book on this localization pack withholds under. */
  regimeForPack(pack: string): string {
    return this.byPack.get(pack) ?? "GENERIC_WHT";
  }

  forPack(pack: string): WithholdingEngine {
    return this.get(this.regimeForPack(pack));
  }

  list(): Array<{ regime: string; status: "enabled" | "stub" }> {
    return [...this.engines.values()].map((e) => ({ regime: e.regime, status: e.status }));
  }
}
