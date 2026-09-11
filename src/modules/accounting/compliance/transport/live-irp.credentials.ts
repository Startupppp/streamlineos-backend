import type { AppConfig } from "../../../../config/env.validation";

/**
 * What counts as a usable connection to an Invoice Registration Portal.
 *
 * Separated from the adapter because it is the whole of ACC-14's "block if no
 * creds" and none of its HTTP: the registry, the boot check and the adapter all
 * ask the same question here, and the answer is a value rather than a throw so
 * each of them can say something different about it.
 *
 * Nothing in this file ever returns a credential's VALUE. A problem is named in
 * variables, because the string it produces reaches a boot error and a log line,
 * and a secret that reaches either is leaked for as long as the logs are kept.
 */

/** How long to wait for the portal when the deployment says nothing. */
export const DEFAULT_IRP_TIMEOUT_MS = 15_000;

/** Loopback is the one host allowed to speak plain HTTP — see `credentialsFrom`. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface IrpCredentials {
  url: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  timeoutMs: number;
}

/** Either a usable credential set, or the reason there isn't one — names only. */
export type CredentialState =
  | { ok: true; credentials: IrpCredentials }
  | { ok: false; problem: string };

export type LiveIrpConfig = Pick<
  AppConfig,
  | "COMPLIANCE_IRP_URL"
  | "COMPLIANCE_IRP_CLIENT_ID"
  | "COMPLIANCE_IRP_CLIENT_SECRET"
  | "COMPLIANCE_IRP_USERNAME"
  | "COMPLIANCE_IRP_PASSWORD"
  | "COMPLIANCE_IRP_TIMEOUT_MS"
>;

/**
 * The credential set, or the reason there is none.
 *
 * All five or nothing. A partial set is the failure this ticket is named after:
 * four variables set and one forgotten would otherwise produce an adapter that
 * is registered, looks real on a screen, and fails at the first filing — or
 * worse, sends a request with a blank password and reads the 401 as something
 * about the invoice.
 *
 * `env.validation` refuses the boot for the same partial set when
 * `COMPLIANCE_TRANSPORT=irp`, and this is not redundant with it: the schema
 * checks presence, this checks usability, and a deployment can also arrive here
 * without having opted in at all.
 */
export function credentialsFrom(config: LiveIrpConfig): CredentialState {
  const url = config.COMPLIANCE_IRP_URL?.trim() ?? "";
  const clientId = config.COMPLIANCE_IRP_CLIENT_ID?.trim() ?? "";
  const clientSecret = config.COMPLIANCE_IRP_CLIENT_SECRET?.trim() ?? "";
  const username = config.COMPLIANCE_IRP_USERNAME?.trim() ?? "";
  const password = config.COMPLIANCE_IRP_PASSWORD?.trim() ?? "";

  const missing = Object.entries({
    COMPLIANCE_IRP_URL: url,
    COMPLIANCE_IRP_CLIENT_ID: clientId,
    COMPLIANCE_IRP_CLIENT_SECRET: clientSecret,
    COMPLIANCE_IRP_USERNAME: username,
    COMPLIANCE_IRP_PASSWORD: password,
  })
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    return { ok: false, problem: `not set: ${missing.join(", ")}` };
  }

  const parsed = parseUrl(url);
  if (!parsed) return { ok: false, problem: "COMPLIANCE_IRP_URL is not a URL" };

  /*
    Plain HTTP would put a GSP password on the wire in clear text. Loopback is
    excepted so the adapter can be exercised against a stub server in a test — a
    credential that never leaves the machine cannot be intercepted on it, and the
    alternative is an adapter whose only untested path is the one that runs in
    production.
  */
  if (parsed.protocol !== "https:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return {
      ok: false,
      problem:
        "COMPLIANCE_IRP_URL must be https — plain HTTP would send the GSP password in clear text",
    };
  }

  return {
    ok: true,
    credentials: {
      url,
      clientId,
      clientSecret,
      username,
      password,
      timeoutMs: config.COMPLIANCE_IRP_TIMEOUT_MS ?? DEFAULT_IRP_TIMEOUT_MS,
    },
  };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
