import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { APP_CONFIG } from "../../../../config/config.module";
import type { AppConfig } from "../../../../config/env.validation";
import { MockIrpAdapter } from "./mock-irp.adapter";
import type { ComplianceTransportAdapter } from "./compliance-transport.port";

/**
 * Which transport, if any, this deployment has.
 *
 * `none` is the default and the only honest answer until a provider exists: a
 * reportable document is recorded `pending` and nobody sends it, which is
 * exactly what the product does today.
 *
 * The registry refuses a mock in production rather than warning about it. A
 * warning is a line in a log that nobody reads until the week somebody notices
 * their GST returns do not match their invoices; a refusal at boot is noticed
 * in the deploy that caused it. `COMPLIANCE_TRANSPORT=mock` on a production
 * node is a misconfiguration whose failure mode is fabricated statutory
 * evidence, and the cost of being wrong in that direction is not symmetric with
 * the cost of a failed boot.
 */
@Injectable()
export class ComplianceTransportRegistry implements OnModuleInit {
  private readonly logger = new Logger(ComplianceTransportRegistry.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mockIrp: MockIrpAdapter,
  ) {}

  onModuleInit(): void {
    const configured = this.configured();
    const adapter = this.resolve();

    if (configured === "mock" && this.isProduction()) {
      throw new Error(
        "COMPLIANCE_TRANSPORT=mock is set on a production node. The mock transport " +
          "produces synthetic acknowledgements and files nothing; running it here would " +
          "record fabricated evidence of a statutory filing. Set COMPLIANCE_TRANSPORT=none.",
      );
    }

    this.logger.log(
      adapter
        ? `E-invoice transport: ${adapter.name}${adapter.isReal ? "" : " — SYNTHETIC, nothing is filed"}`
        : "E-invoice transport: none. Reportable documents are recorded and not sent.",
    );
  }

  /** The adapter this deployment runs, or null when nothing is wired up. */
  resolve(): ComplianceTransportAdapter | null {
    if (this.configured() !== "mock") return null;
    if (this.isProduction()) return null;
    return this.mockIrp;
  }

  /**
   * What a screen should say about filing. Separated from `resolve` so the
   * honest empty state does not have to know what an adapter is.
   */
  describe(): { configured: boolean; real: boolean; name: string } {
    const adapter = this.resolve();
    if (!adapter) {
      return {
        configured: false,
        real: false,
        name: "No e-invoice connection is configured. Reportable documents must be filed directly with the authority.",
      };
    }
    return { configured: true, real: adapter.isReal, name: adapter.name };
  }

  private configured(): string {
    return this.config.COMPLIANCE_TRANSPORT ?? "none";
  }

  private isProduction(): boolean {
    return this.config.NODE_ENV === "production";
  }
}
