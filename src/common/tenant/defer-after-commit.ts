import { registerAfterCommit } from "./tenant-context";

/**
 * Run `work` once the request transaction has committed, or immediately when
 * there is no transaction to wait for.
 *
 * `registerAfterCommit` returns false outside a request — a cron sweep, a
 * worker — and the work still has to happen, so the fallback runs it inline
 * rather than dropping it. Either way the caller does not wait: the request's
 * pooled connection is released before `work` touches the network.
 *
 * `onFailure` is required because the fallback path has nowhere to throw. A
 * deferred failure that nobody reports is the next outage nobody sees.
 */
export function deferAfterCommit(
  work: () => Promise<unknown>,
  onFailure: (error: unknown) => void,
): void {
  if (registerAfterCommit(work)) return;
  void work().catch(onFailure);
}
