import { getTenantContext } from "../../../common/tenant/tenant-context";

type AsyncResult<T> = Promise<T>;

export class ProjectAccessCache<T = { hasAccess: boolean; role: string | null }> {
  private readonly store = new Map<string, AsyncResult<T>>();

  get(
    orgId: string,
    userId: string,
    projectId: number,
    compute: () => AsyncResult<T>,
  ): AsyncResult<T> {
    const key = `${orgId}:${userId}:${projectId}`;
    const cached = this.store.get(key);
    if (cached !== undefined) return cached;
    const promise = compute().catch((err: unknown) => {
      this.store.delete(key);
      throw err;
    });
    this.store.set(key, promise);
    return promise;
  }

  invalidate(projectId?: number): void {
    if (projectId === undefined) {
      this.store.clear();
      return;
    }
    const suffix = `:${projectId}`;
    for (const key of this.store.keys()) {
      if (key.endsWith(suffix)) this.store.delete(key);
    }
  }
}

const requestCaches = new WeakMap<object, ProjectAccessCache>();

export function getOrCreateRequestCache(): ProjectAccessCache {
  const ctx = getTenantContext();
  if (!ctx) return new ProjectAccessCache();
  const existing = requestCaches.get(ctx);
  if (existing) return existing;
  const fresh = new ProjectAccessCache();
  requestCaches.set(ctx, fresh);
  return fresh;
}
