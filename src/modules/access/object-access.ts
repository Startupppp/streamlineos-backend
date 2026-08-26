import type { DataScope } from "./access.types";

export interface ObjectAccessContext {
  orgId: string;
  actorId: string;
  scope: DataScope;
}

export type ObjectQuery<T> = (ctx: ObjectAccessContext) => Promise<T | null>;
