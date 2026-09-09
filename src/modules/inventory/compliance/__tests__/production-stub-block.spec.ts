import { validateEnv } from "../../../../config/env.validation";
import {
  productionBlockedStubAdapter,
  STUB_COMPLIANCE_ADAPTER,
} from "../india-compliance-adapter";
import { IndiaComplianceService } from "../india-compliance.service";
import { ChannelAdapterRegistrar } from "../../channels/fake-channel-adapter";
import { ChannelAdapterRegistry } from "../../channels/channel-adapter";

/**
 * INV-25 / INV-27 — production may not mint a compliance identifier or a
 * marketplace quantity that nobody issued.
 *
 * The pack's denylist forbids a fake IRN, e-waybill, carrier id or marketplace
 * figure being "presentable as production compliance". Before this, the entire
 * safeguard on each side was a label: the compliance stub prefixed its
 * identifiers with `STUB-` and recorded `adapter_is_live = false`; the channel
 * fake logged a warning at boot. Both are honest and neither is a block, and
 * every gate above them is a *tenant* setting — `complianceAdapter` is a
 * writable string whose default is `"stub"`, so an admin turning on e-invoicing
 * on a live deployment got invented IRNs written to
 * `inv_compliance_documents.external_id`.
 *
 * These are the two refusals, and each is checked in both directions: it fires
 * in production, and it does not fire outside it. A block that also refused in
 * development would be discovered by breaking every developer's machine, and
 * would then be removed.
 */

/**
 * Everything `validateEnv` demands of a production deployment, so the only
 * variable under test is the one this file is about. Mirrors the fixture in
 * `src/config/env.validation.spec.ts` plus the five the production
 * `superRefine` adds.
 */
const PRODUCTION_BASE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://owner:p@localhost:5432/db",
  APP_DATABASE_URL: "postgres://app:p@localhost:5432/db",
  BACKEND_JWT_SECRET: "x".repeat(44),
  PORTAL_JWT_SECRET: "y".repeat(44),
  CORS_ORIGINS: "https://app.example.com",
  APP_URL: "https://app.example.com",
  ENCRYPTION_KEY: "e".repeat(64),
  CRON_SECRET: "s".repeat(32),
  INTERNAL_API_SECRET: "i".repeat(32),
  CONTACT_NOTIFICATION_EMAIL: "ops@example.com",
} as const;

describe("INV-25 — the compliance stub cannot mint an IRN in production", () => {
  it("resolves the stub to a refusal when NODE_ENV is production", () => {
    const service = Object.create(IndiaComplianceService.prototype) as IndiaComplianceService;
    Object.assign(service, { config: { NODE_ENV: "production" } });

    const adapter = (
      service as unknown as { adapterFor: (code: string) => { code: string } }
    ).adapterFor("stub");

    expect(adapter).not.toBe(STUB_COMPLIANCE_ADAPTER);
  });

  it("still resolves to the real stub outside production, so development works", () => {
    const service = Object.create(IndiaComplianceService.prototype) as IndiaComplianceService;
    Object.assign(service, { config: { NODE_ENV: "development" } });

    const adapter = (
      service as unknown as { adapterFor: (code: string) => unknown }
    ).adapterFor("stub");

    expect(adapter).toBe(STUB_COMPLIANCE_ADAPTER);
  });

  it("answers a registration attempt with no identifier at all", async () => {
    const result = await productionBlockedStubAdapter().register({
      kind: "EINVOICE",
      sourceType: "inv_shipment",
      sourceId: "1",
      documentNumber: "SHP-1",
      payloadHash: "a".repeat(64),
      lines: [],
    });

    expect(result.status).toBe("FAILED");
    if (result.status !== "FAILED") return;
    expect(result.code).toBe("STUB_ADAPTER_FORBIDDEN_IN_PRODUCTION");
    // Terminal, because no number of retries produces a tax authority. A
    // non-terminal refusal would sit in the ladder re-asking for ten seconds
    // and then record the same answer.
    expect(result.terminal).toBe(true);
    // The whole point: nothing that could be written to `external_id`.
    expect(result).not.toHaveProperty("externalId");
  });

  it("refuses to cancel a filing that was never made", async () => {
    const result = await productionBlockedStubAdapter().cancel({
      kind: "EINVOICE",
      externalId: "STUB-EINVOICE-DEADBEEF",
      reason: "test",
    });
    expect(result.status).toBe("FAILED");
  });

  it("reports itself as not live, so a stored row still records what answered", () => {
    // `adapter_is_live` describes whether a real provider was spoken to. The
    // refusal did not speak to one either, and claiming otherwise would put a
    // true-looking provenance flag on a row that never left the process.
    expect(productionBlockedStubAdapter().isLive).toBe(false);
  });
});

describe("INV-27 — the fake channel adapter cannot register in production", () => {
  const registrarWith = (nodeEnv: string, adapter: string | undefined) =>
    new ChannelAdapterRegistrar(
      { NODE_ENV: nodeEnv, INV_CHANNEL_ADAPTER: adapter } as never,
      new ChannelAdapterRegistry(),
    );

  it("throws at module init rather than answering snapshots with invented numbers", () => {
    expect(() => registrarWith("production", "fake").onModuleInit()).toThrow(
      /forbidden in production/i,
    );
  });

  it("registers nothing and throws nothing in production when the adapter is not asked for", () => {
    const registry = new ChannelAdapterRegistry();
    const registrar = new ChannelAdapterRegistrar(
      { NODE_ENV: "production", INV_CHANNEL_ADAPTER: "none" } as never,
      registry,
    );
    expect(() => registrar.onModuleInit()).not.toThrow();
    // Nothing registered, so every channel falls back to manual — which fetches
    // nothing and reports `complete: false`, so no number it produces can be
    // mistaken for a marketplace's own count.
    expect(registry.forChannelType("SHOPIFY").canFetch).toBe(false);
    expect(() => registrarWith("production", undefined).onModuleInit()).not.toThrow();
  });

  it("still registers the fake in development", () => {
    const registry = new ChannelAdapterRegistry();
    const registrar = new ChannelAdapterRegistrar(
      { NODE_ENV: "development", INV_CHANNEL_ADAPTER: "fake" } as never,
      registry,
    );
    expect(() => registrar.onModuleInit()).not.toThrow();
    // `canFetch` is what separates the fake from `MANUAL_CHANNEL_ADAPTER`, the
    // fallback an unregistered channel type resolves to. Asserting it is what
    // makes this a check that the fake registered, rather than a check that the
    // registry answered at all.
    expect(registry.forChannelType("SHOPIFY").canFetch).toBe(true);
  });

  it("refuses to validate a production environment that asks for the fake at all", () => {
    // The outer of the two layers. This one stops the process starting, so the
    // registrar's throw is only ever reached by an AppConfig assembled some
    // other way.
    expect(() =>
      validateEnv({ ...PRODUCTION_BASE, INV_CHANNEL_ADAPTER: "fake" }),
    ).toThrow(/INV_CHANNEL_ADAPTER/);
  });

  it("accepts the same production environment with the fake turned off", () => {
    // The anti-vacuity half, and it earned its place on the first run: the
    // fixture was missing five required variables, so the test above was
    // passing on `BACKEND_JWT_SECRET` and would have gone on passing with the
    // block deleted.
    expect(() => validateEnv({ ...PRODUCTION_BASE, INV_CHANNEL_ADAPTER: "none" })).not.toThrow();
    expect(() => validateEnv({ ...PRODUCTION_BASE })).not.toThrow();
  });

  it("still accepts the fake outside production", () => {
    expect(() =>
      validateEnv({ ...PRODUCTION_BASE, NODE_ENV: "development", INV_CHANNEL_ADAPTER: "fake" }),
    ).not.toThrow();
  });
});
