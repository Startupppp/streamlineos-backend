import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { APP_CONFIG } from "../../../../config/config.module";
import type { AppConfig } from "../../../../config/env.validation";
import { LiveIrpAdapter } from "./live-irp.adapter";
import { MockIrpAdapter } from "./mock-irp.adapter";
import type { ComplianceTransportAdapter } from "./compliance-transport.port";

/**
 * Which transport, if any, this deployment has.
 *
 * `none` is the default and the only honest answer for a deployment with no GSP
 * account: a reportable document is recorded `pending` and nobody sends it,
 * which is exactly what the product does without this wiring.
 *
 * Two refusals live here rather than in a log line, and they refuse in opposite
 * directions for the same reason — the cost of being wrong is not symmetric with
 * the cost of a failed boot.
 *
 *  - **A mock in production** would record fabricated evidence of a statutory
 *    filing. A warning is a line nobody reads until the week somebody notices
 *    their GST returns do not match their invoices; a refusal is noticed in the
 *    deploy that caused it.
 *  - **A live transport with no usable credentials** is the same failure with
 *    the sign flipped: the deployment believes it files and files nothing.
 *    `env.validation` already refuses a boot whose credential set is incomplete;
 *    this refuses the ones it cannot see — a URL that is not HTTPS, a value that
 *    is not a URL — and refuses to *resolve* either way, so a node that somehow
 *    started still sends nothing rather than sending half a request.
 */
@Injectable()
export class ComplianceTransportRegistry implements OnModuleInit {
  private readonly logger = new Logger(ComplianceTransportRegistry.name);

  constructor(
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "COMPLIANCE_TRANSPORT" | "NODE_ENV">,
    private readonly mockIrp: MockIrpAdapter,
    private readonly liveIrp: LiveIrpAdapter,
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

    if (configured === "irp" && !this.liveIrp.isConfigured()) {
      /*
        The problem is named in variables, never in values — this string reaches
        a boot log, and a secret that reaches a boot log is leaked for as long as
        the logs are kept.
      */
      throw new Error(
        "COMPLIANCE_TRANSPORT=irp claims this deployment files documents with the tax " +
          `authority, but its credentials are unusable (${this.liveIrp.configurationProblem()}). ` +
          "Nothing would be filed and every reportable document would sit pending. Set " +
          "COMPLIANCE_TRANSPORT=none until the connection is complete.",
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
    switch (this.configured()) {
      case "mock":
        return this.isProduction() ? null : this.mockIrp;
      case "irp":
        /*
          Credentials are the gate, not the enum. `COMPLIANCE_TRANSPORT=irp`
          alone is a statement of intent; a deployment that has not been given a
          GSP account cannot act on it, and pretending otherwise would send a
          request with blank headers and read the 401 as something about the
          invoice.
        */
        return this.liveIrp.isConfigured() ? this.liveIrp : null;
      default:
        return null;
    }
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
