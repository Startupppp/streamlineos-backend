import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import {
  ChannelAdapterRegistry,
  EXTERNAL_CHANNEL_TYPES,
  type ChannelAdapter,
  type ChannelSnapshotRequest,
  type ChannelSnapshotResult,
} from "./channel-adapter";

/**
 * E6 — a channel that answers, for development.
 *
 * Deterministic rather than random: the same SKU always comes back with the same
 * quantity, so a developer walking the path twice sees the difference converge
 * on one row instead of chasing a moving number, and a screenshot of the
 * reconciliation screen means something.
 *
 * It always succeeds and always reports `complete: true`. That is deliberate: a
 * fake that failed intermittently would be a simulation of an outage rather than
 * a rehearsal of the happy path, and every failure mode this boundary has to
 * survive — timeout, a 200 carrying an error body, a partial listing, a
 * duplicate delivery — is asserted directly in
 * `__tests__/channel-snapshot.service.spec.ts` against fakes written for each,
 * where the assertion can be exact.
 *
 * It is **not** registered unless `INV_CHANNEL_ADAPTER=fake`. With no
 * configuration nothing outbound exists at all, which is what an organisation
 * that has not asked for a channel integration should get.
 */
export const FAKE_CHANNEL_ADAPTER: ChannelAdapter = {
  code: "fake",
  canFetch: true,
  fetchSnapshot(request: ChannelSnapshotRequest): Promise<ChannelSnapshotResult> {
    return Promise.resolve({
      ok: true,
      complete: true,
      capturedAt: new Date(),
      items: request.skus.map((sku) => ({ sku, quantity: fakeQuantityFor(sku) })),
      failures: [],
    });
  },
};

/** 0–19, derived from the SKU, as a 4dp decimal string — never a float. */
export function fakeQuantityFor(sku: string): string {
  const digest = createHash("sha256").update(sku, "utf8").digest();
  return `${digest.readUInt16BE(0) % 20}.0000`;
}

/**
 * Registers the fake when the deployment asks for it, and nothing otherwise.
 *
 * A provider rather than a module-level side effect, so that "which adapters
 * exist" is a decision this process made at boot and can be read off one place,
 * rather than a consequence of which files happened to be imported.
 */
@Injectable()
export class ChannelAdapterRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ChannelAdapterRegistrar.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: ChannelAdapterRegistry,
  ) {}

  onModuleInit(): void {
    if (this.config.INV_CHANNEL_ADAPTER !== "fake") return;

    // INV-27. `validateEnv` already refuses this combination at boot, and this
    // is the same refusal one layer down, because the two are reached
    // differently: config is validated from `process.env` at startup, while an
    // `AppConfig` assembled any other way — a test module, a future loader —
    // reaches the registrar without passing through it. A fake that registers
    // itself is not a thing to warn about in production; the quantities it
    // invents are presented to an operator as a marketplace's own count and are
    // acceptable into the stock ledger.
    if (this.config.NODE_ENV === "production") {
      throw new Error(
        "INV_CHANNEL_ADAPTER=fake is forbidden in production: the fake channel adapter invents stock quantities from a hash of the SKU, and those quantities are presentable as a marketplace's own count and acceptable into inv_stock_transactions.",
      );
    }

    for (const channelType of EXTERNAL_CHANNEL_TYPES) {
      this.registry.register(channelType, FAKE_CHANNEL_ADAPTER);
    }
    this.logger.warn(
      "INV_CHANNEL_ADAPTER=fake — channel snapshots are answered by a fake adapter. No marketplace is being contacted.",
    );
  }
}
