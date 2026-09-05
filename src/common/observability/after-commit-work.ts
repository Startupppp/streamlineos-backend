import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<boolean>();
const observers = new Set<(completion: Promise<unknown>) => void>();

export function isAfterCommitWork(): boolean {
  return scope.getStore() === true;
}

export function observeAfterCommitWork(observer: (completion: Promise<unknown>) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export function runAfterCommitWork<T>(handler: () => Promise<T>): Promise<T> {
  const completion = scope.run(true, async () => handler());
  for (const observer of observers) observer(completion);
  return completion;
}
