export type InProcessListener = (key: string) => void;

export class InProcessChannel {
  private readonly listeners = new Set<InProcessListener>();

  subscribe(listener: InProcessListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(key: string): void {
    for (const listener of this.listeners) listener(key);
  }

  reset(): void {
    this.listeners.clear();
  }
}

export const accessVersionChannel = new InProcessChannel();
