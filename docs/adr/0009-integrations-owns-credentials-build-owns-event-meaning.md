# ADR 0009: Integrations owns credentials and delivery; Build owns event meaning and mapping IDs

**Status:** accepted — written from the architecture review (2026-10-01).
**Date:** 2026-10-01.
**Decision:** Build retains event meaning and provider mapping IDs. A deep
Integrations module owns credentials, signing secrets, delivery mechanics,
retry policy, circuit breaking, and provider adapters. Build stores no
provider secrets.

---

## The problem

`core/webhooks/projects-webhooks.service.ts` generates and stores webhook
signing secrets inside the Build schema:

```
projects-webhooks.service.ts:165 — const secret = data.secret ?? generateWebhookSecret();
projects-webhooks.service.ts:174-175 — secret, secretSetAt: new Date(),
```

The dispatch path (`projects-webhooks-dispatch.service.ts`) also owns retry
logic, circuit-breaker state, and HTTP transport. This is integration-layer
implementation co-located with domain logic.

The BLD-00 D12 decision is explicit: "Webhook secrets, rotation, and encryption
belong to Integrations/Composio. Build stores connection and mapping IDs only."
The current code contradicts that decision.

The same concern extends to any future Git provider credential: storing it in
Build would repeat the pattern.

## The decision

Build publishes a **typed delivery intent** to the Integrations interface. The
intent carries:

- the Build event type and semantic payload (e.g., `ticket.status_changed`);
- the **mapping ID** that ties a Build project to an external endpoint record
  owned by Integrations.

Integrations (or Composio) owns:

- credential storage, signing secret generation and rotation;
- delivery rows, retry policy, and exponential backoff;
- circuit-breaker state;
- HTTP transport and TLS;
- provider adapters (webhook, git provider push/pull).

Build retains:

- the meaning of each event type;
- the mapping ID that connects a Build project to an Integrations endpoint;
- the decision of which events trigger a delivery intent.

`core/webhooks/` is the current owner of the delivery enqueue path. Until
Integrations owns a live delivery interface, this module may continue to enqueue
outbox rows — but it must not generate or store signing secrets, and it must
not own retry or circuit-breaker state. Secrets migrate to Integrations before
any new provider is advertised.

## Consequences

**Build stores no secrets.** A `grep -rn "secret\|signing_secret" backend/src/
modules/build/` with no hits in non-webhook-config files is the conformance
signal. The current webhook signing secret column migrates to Integrations when
the delivery interface is ready.

**Failure isolation.** Delivery-layer failures (timeouts, provider outages,
secret rotation) are handled inside Integrations and do not propagate back to
Build. Build sees `delivery intent accepted` or `delivery interface unavailable`.

**Advertised providers require implementation.** A provider shown in the Build
integration selector must have a verified delivery path in Integrations before
it may be selected. Bitbucket remains removed from schema, types, and selectors
until that contract exists (BLD-00 D12).

**Inbound events.** Signature verification, durable receipt, and replay are
Integrations responsibilities. Build receives a verified, tenant-resolved event
payload and processes it idempotently.

## The rule that holds

> Build knows what an event means and which mapping it belongs to. Integrations
> knows how to deliver it and where the secrets live.
