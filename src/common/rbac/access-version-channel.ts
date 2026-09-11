import { Logger } from "@nestjs/common";

export type AccessVersionListener = (orgId: string) => void;

/**
 * The shared half of the channel. `clear` is the cross-instance signal: the
 * durable row stays the authority, so a version can never move backwards into a
 * number some other instance already cached against.
 */
export interface AccessVersionStore {
  get(orgId: string): Promise<number | null>;
  set(orgId: string, version: number): Promise<void>;
  clear(orgId: string): Promise<void>;
}

export class AccessVersionChannel {
  private readonly logger = new Logger(AccessVersionChannel.name);
  private store: AccessVersionStore | null = null;
  private readonly listeners = new Set<AccessVersionListener>();

  useStore(store: AccessVersionStore | null): void {
    this.store = store;
  }

  hasStore(): boolean {
    return this.store !== null;
  }

  subscribe(listener: AccessVersionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Local listeners fire first and synchronously, so this instance is correct
   * before the shared signal is attempted and stays correct if it fails.
   */
  async publish(orgId: string): Promise<void> {
    for (const listener of this.listeners) listener(orgId);
    if (!this.store) return;
    try {
      await this.store.clear(orgId);
    } catch (error: unknown) {
      this.logger.error(
        `Access revocation for org ${orgId} did not reach the shared channel; other instances keep the previous version until its TTL expires: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async read(
    orgId: string,
    loadDurable: () => Promise<number>,
  ): Promise<number> {
    if (this.store) {
      try {
        const shared = await this.store.get(orgId);
        if (shared !== null) return shared;
      } catch {
        return loadDurable();
      }
    }

    const durable = await loadDurable();
    if (this.store) {
      try {
        await this.store.set(orgId, durable);
      } catch {
        return durable;
      }
    }
    return durable;
  }

  reset(): void {
    this.listeners.clear();
    this.store = null;
  }
}

export const accessVersionChannel = new AccessVersionChannel();
