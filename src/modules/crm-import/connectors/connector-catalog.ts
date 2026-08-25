import { HUBSPOT_CONNECTOR } from "./hubspot.connector";
import { PIPEDRIVE_CONNECTOR } from "./pipedrive.connector";
import { SALESFORCE_CONNECTOR } from "./salesforce.connector";
import { ZOHO_CONNECTOR } from "./zoho.connector";
import type {
  ConnectorDescriptor,
  ConnectorProvider,
  ConnectorStream,
  ConnectorStreamDescriptor,
} from "./connector-source";

/**
 * The four connectors, as one exhaustive record.
 *
 * A `Record<ConnectorProvider, …>` rather than a lookup that can miss, for the
 * reason `ComposioGateway.authConfigIdFor` is one: adding a provider to the
 * union is then a compile error here until somebody writes its descriptor,
 * instead of a runtime `undefined` that reads as "that provider returned
 * nothing".
 */
export const CONNECTORS: Readonly<Record<ConnectorProvider, ConnectorDescriptor>> = {
  salesforce: SALESFORCE_CONNECTOR,
  hubspot: HUBSPOT_CONNECTOR,
  zoho: ZOHO_CONNECTOR,
  pipedrive: PIPEDRIVE_CONNECTOR,
};

export function connectorFor(provider: ConnectorProvider): ConnectorDescriptor {
  return CONNECTORS[provider];
}

export function streamFor(
  provider: ConnectorProvider,
  stream: ConnectorStream,
): ConnectorStreamDescriptor {
  return CONNECTORS[provider].streams[stream];
}

/**
 * ── What has to be true before any of this can run ─────────────────────────
 *
 * None of it is true today, and each is a change to a file this ticket does not
 * own. Reported in code rather than in a paragraph somewhere, for the same
 * reason `telephony-call-log.service.ts` reports its three: the shape of what
 * has to be wired is more useful stated as a list somebody can diff against, and
 * every refusal below has to survive the wiring.
 *
 *   1. `IntegrationToolkit` (`db/schema/common/integrations.ts`) is
 *      `"googlecalendar" | "outlook" | "gmail"`. None of these four is in it, so
 *      a CRM connection cannot be finalised. There are three independent copies
 *      of that list — the type, the Zod enum in
 *      `integrations/core/dto/integrations.schemas.ts`, and the runtime
 *      narrowing in `IntegrationsService.toToolkit` — and only the first two are
 *      even in the same shape, so widening one and not the others compiles.
 *
 *   2. `ComposioGateway.authConfigIdFor` is an exhaustive
 *      `Record<IntegrationToolkit, string | undefined>` over three environment
 *      variables. Adding a member is a compile error there until it has an auth
 *      config, which is exactly the guard that file was given after a previous
 *      fall-through sent somebody to Outlook's consent screen. So each of these
 *      four needs a `COMPOSIO_AUTH_CONFIG_*` variable before it has anywhere to
 *      send a person.
 *
 *   3. `ComposioGateway.getAccountEmail` has no branch for any of them, so a
 *      finalised connection would carry no label. That is cosmetic next to the
 *      other two, and it is what the connections list shows a person.
 *
 * ── What this file deliberately does NOT do ────────────────────────────────
 *
 * It does not name a single Composio tool slug. Every request goes out through
 * `ComposioGateway.executeProxy`, which is an HTTP path: a wrong path is a 404
 * and `executeProxy` throws on any status at or above 400, so a mistake is loud
 * and immediate. A wrong *tool slug* argument is dropped in silence, and a
 * channel that silently ingests nothing looks healthy for weeks. That trade is
 * the same one `telephony-call-log.ts` made and recorded, and it is the reason
 * `toolkit` below is a plain string rather than a member of a union: it is the
 * value `user_integration_connections.toolkit` would carry, and that column is
 * plain `text`, so the value is representable today even though nothing can
 * create it.
 *
 * The paths and payload shapes are transcribed from each provider's public REST
 * documentation and are **unverified against a live account** — nothing in this
 * repository has ever called any of these four. Where a request could only be
 * built by guessing an argument name, it is not built at all: Zoho's and
 * HubSpot's incremental filters are both absent for that reason, and each
 * connector says so where the guess would have gone. A parameter a provider does
 * not recognise is ignored rather than rejected, which returns a plausible page
 * that is the wrong window — so the rule throughout is that the request is kept
 * to the smallest thing that can be wrong.
 */
export const CONNECTOR_WIRING_BLOCKERS: readonly string[] = [
  "IntegrationToolkit has no CRM member, so a connection cannot be finalised",
  "ComposioGateway.authConfigIdFor has no CRM auth config",
  "ComposioGateway.getAccountEmail has no CRM branch, so a connection has no label",
];
