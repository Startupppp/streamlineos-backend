import { AsyncLocalStorage } from "node:async_hooks";

export interface ImpersonationContext {
  realActorUserId: string;
  impersonationSessionId: string;
}

const storage = new AsyncLocalStorage<ImpersonationContext>();

export function getImpersonationContext(): ImpersonationContext | undefined {
  return storage.getStore();
}

export function runWithImpersonationContext<T>(
  context: ImpersonationContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}
