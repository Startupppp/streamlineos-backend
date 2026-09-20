import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { APP_CONFIG } from "../../../../config/config.module";
import type { ComplianceTransport } from "../../../../db/schema";
import type {
  CompliancePayload,
  ComplianceTransportAdapter,
  TransportResult,
} from "./compliance-transport.port";
import {
  credentialsFrom,
  type CredentialState,
  type IrpCredentials,
  type LiveIrpConfig,
} from "./live-irp.credentials";
import { buildIrpRequest } from "./live-irp.request";
import { interpretIrpResponse } from "./live-irp.response";

/**
 * The live e-invoice transport: a real HTTP call to a real Invoice Registration
 * Portal, through whichever GSP a deployment has an account with.
 *
 * ACC-14, and the ticket's own title is the design: *optional, behind env
 * secrets, blocked with no creds*. Nothing in this repository has GST portal
 * credentials, and nothing should acquire them by accident, so this class is
 * inert in every deployment that has not been given all five variables — it is
 * not resolved by `ComplianceTransportRegistry`, and the submit route answers
 * its existing honest 409.
 *
 * Three properties are worth stating plainly, because each is a way this could
 * have gone wrong:
 *
 *  1. **It never claims a filing it did not get.** Every path out of `submit`
 *     returns a `TransportResult` built from what came back, and the only
 *     `accepted` is one carrying an IRN, an acknowledgement number and a
 *     readable acknowledgement date. A timeout, a 5xx, a credential failure and
 *     an unreadable body are all `unavailable`, which `ComplianceService`
 *     records as still-`pending` — the authority judged nothing, so nothing may
 *     be said about the document.
 *  2. **It never echoes a credential.** The secrets go into request headers and
 *     nowhere else: not into a log line, not into a reason, not into the
 *     `errors` jsonb that ends up on a screen. Anything a provider sends back
 *     passes through `redact`, so a GSP that quotes what it was sent cannot turn
 *     an error message into a credential leak.
 *  3. **It cannot register the same invoice twice.** See `idempotencyKeyFor`.
 *
 * **What this adapter can file.** A domestic B2B forward-charge document in
 * rupees, with both GSTINs present. `buildIrpRequest` refuses everything else
 * rather than guess at a supply type the port does not carry. That refusal is
 * honest, and it is also a limitation: an export or a reverse-charge supply
 * cannot be filed through this product until `CompliancePayload` carries the
 * supply nature `ComplianceService.decide` already computes.
 */
@Injectable()
export class LiveIrpAdapter implements ComplianceTransportAdapter {
  /**
   * `irp` — the same member `ComplianceService.decide` writes when it decides a
   * document is reportable. Deliberate: the transport that wants the document is
   * the transport that handled it, so a real submission *updates* the obligation
   * row rather than sitting beside it. The mock needs a member of its own
   * precisely because it is not that transport.
   */
  readonly transport: ComplianceTransport = "irp";
  readonly name = "Invoice Registration Portal (live — documents are filed)";
  readonly isReal = true;

  private readonly logger = new Logger(LiveIrpAdapter.name);

  /**
   * Read once, at construction, exactly as `EnvSmsSender` does. Whether this
   * deployment can file must not change between the moment a screen tells
   * somebody it can and the moment they press the button.
   */
  private readonly state: CredentialState;

  constructor(@Inject(APP_CONFIG) config: LiveIrpConfig) {
    this.state = credentialsFrom(config);
  }

  /** Whether this deployment has been given a real IRP connection. */
  isConfigured(): boolean {
    return this.state.ok;
  }

  /** Why it has not, in variable names — never a value. */
  configurationProblem(): string | null {
    return this.state.ok ? null : this.state.problem;
  }

  async submit(payload: CompliancePayload): Promise<TransportResult> {
    if (!this.state.ok) {
      /*
        Unreachable through the registry, which refuses to resolve an
        unconfigured adapter — and implemented anyway, because "unreachable" is a
        claim about today's wiring. `unavailable` rather than a throw: the
        document was not sent and has not been judged, which is precisely what
        `unavailable` records.
      */
      return {
        outcome: "unavailable",
        reason: `No e-invoice credentials are configured, so nothing was sent (${this.state.problem}).`,
      };
    }
    const credentials = this.state.credentials;

    const build = buildIrpRequest(payload);
    if (!build.ok) return { outcome: "unavailable", reason: build.reason };

    try {
      const response = await fetch(credentials.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          user_name: credentials.username,
          password: credentials.password,
          gstin: payload.sellerTaxId,
          "Idempotency-Key": idempotencyKeyFor(payload),
        },
        body: JSON.stringify(build.request),
        /*
          A redirect is refused rather than followed. `fetch` strips
          `Authorization` on a cross-origin redirect and does NOT strip custom
          headers, so following one would hand `client_secret` and `password` to
          whatever host the response named. A filing endpoint has no legitimate
          redirect, so the safe behaviour costs nothing.
        */
        redirect: "error",
        signal: AbortSignal.timeout(credentials.timeoutMs),
      });

      return this.redact(await this.readResponse(response), credentials);
    } catch (error) {
      return this.redact(this.fromTransportError(error, credentials.timeoutMs), credentials);
    }
  }

  /**
   * The HTTP layer's own verdicts, before the envelope is read.
   *
   * Three statuses are answered without parsing, for the same reason each time:
   * the body is not a judgement of the document, so reading it could only
   * produce a misleading one.
   */
  private async readResponse(response: Response): Promise<TransportResult> {
    if (response.status === 401 || response.status === 403) {
      /*
        A credential problem, never a rejection — the document was not looked at.
        The body is deliberately not read: an authentication error is the one
        response most likely to quote what it was sent.
      */
      this.logger.error(
        `The e-invoice provider refused this deployment's credentials (HTTP ${response.status}). ` +
          "Check COMPLIANCE_IRP_CLIENT_ID / COMPLIANCE_IRP_CLIENT_SECRET / COMPLIANCE_IRP_USERNAME / COMPLIANCE_IRP_PASSWORD.",
      );
      return {
        outcome: "unavailable",
        reason:
          "The e-invoice provider did not accept this deployment's credentials, so the document " +
          "was not filed. Nothing about it has been judged.",
      };
    }

    if (response.status === 429) {
      return {
        outcome: "unavailable",
        reason:
          "The e-invoice provider is rate-limiting this deployment. The document was not filed.",
      };
    }

    if (response.status >= 500) {
      return {
        outcome: "unavailable",
        reason: `The e-invoice provider answered HTTP ${response.status}. The document was not filed.`,
      };
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      /*
        A gateway's HTML error page, typically. The text is not quoted back — it
        is unbounded, it is not a judgement, and a proxy is the other thing that
        might echo a request header.
      */
      return {
        outcome: "unavailable",
        reason: `The e-invoice provider answered HTTP ${response.status} with a body that is not JSON. The document was not filed.`,
      };
    }

    return interpretIrpResponse(body);
  }

  /** A thrown request: a timeout, a refused connection, a refused redirect. */
  private fromTransportError(error: unknown, timeoutMs: number): TransportResult {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      /*
        The most dangerous of the failures, and the reason `unavailable` exists
        as a third outcome. A document that timed out may well have been
        registered — the request reached the IRP and the answer did not come back
        — so it must not be called filed and must not be called rejected.
        `pending` is the truth, and the IRP's own duplicate detection makes the
        retry safe.
      */
      this.logger.warn(`The e-invoice provider did not answer within ${timeoutMs}ms.`);
      return {
        outcome: "unavailable",
        reason:
          `The e-invoice provider did not answer within ${timeoutMs}ms. This document may or may ` +
          "not have been registered; a retry is safe, because the portal returns the same IRN " +
          "for a document it has already registered.",
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`The e-invoice provider could not be reached: ${message}`);
    return {
      outcome: "unavailable",
      reason: `The e-invoice provider could not be reached, so the document was not filed (${message}).`,
    };
  }

  /**
   * Strip anything that came back carrying one of our own secrets.
   *
   * Belt and braces over property 2 above. The reasons this file writes contain
   * no credentials by construction; a provider's `ErrorMessage` is written by
   * somebody else and lands in `gl_document_compliance.errors`, which is served
   * to a screen. One GSP quoting a header back in an error message would
   * otherwise put a password on a page and in a database backup.
   */
  private redact(result: TransportResult, credentials: IrpCredentials): TransportResult {
    const secrets = [credentials.clientSecret, credentials.password, credentials.clientId];
    const clean = (text: string): string =>
      secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), text);

    switch (result.outcome) {
      case "accepted":
        return result;
      case "rejected":
        return {
          outcome: "rejected",
          errors: result.errors.map((error) => ({
            code: clean(error.code),
            message: clean(error.message),
          })),
        };
      case "unavailable":
        return { outcome: "unavailable", reason: clean(result.reason) };
    }
  }
}

/**
 * A stable key for one document, sent as `Idempotency-Key`.
 *
 * The innermost of three fences against registering an invoice twice, and the
 * weakest — a GSP that ignores the header loses nothing, because the other two
 * do not depend on it:
 *
 *  1. `ComplianceService.fileDocument` will not call an adapter for a
 *     document that already holds an acknowledgement from that transport.
 *  2. The IRP derives an IRN from the seller's GSTIN, the document number and
 *     the financial year, so a second registration of the same document returns
 *     the first one's IRN as a duplicate — which `interpretIrpResponse` reads as
 *     the acceptance it is.
 *  3. This header, for a GSP that dedupes on it.
 *
 * Hashed rather than sent raw, so the header carries no tenant identifiers to a
 * third party that has no use for them.
 */
export function idempotencyKeyFor(payload: CompliancePayload): string {
  return createHash("sha256")
    .update(`${payload.documentType}:${payload.documentId}:${payload.documentNumber}`)
    .digest("hex");
}
