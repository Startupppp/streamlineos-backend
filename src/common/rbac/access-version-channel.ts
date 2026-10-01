export type AccessVersionListener = (orgId: string) => void;

export class AccessVersionChannel {
  private readonly listeners = new Set<AccessVersionListener>();

  subscribe(listener: AccessVersionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(orgId: string): void {
    for (const listener of this.listeners) listener(orgId);
  }

  reset(): void {
    this.listeners.clear();
  }
}

export const accessVersionChannel = new AccessVersionChannel();
