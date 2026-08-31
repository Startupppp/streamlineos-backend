export type InvalidationTrigger =
  | { kind: "write"; events: string[] }
  | { kind: "ttl-only"; reason: string };

export interface CacheNamespaceEntry {
  namespace: string;
  description: string;
  invalidation: InvalidationTrigger;
}
