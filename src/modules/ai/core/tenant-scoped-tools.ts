import type { ToolSet } from "ai";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../db/drizzle.module";

type ToolDefinition = ToolSet[string];

/**
 * A streaming handler returns as soon as it hands the stream to the response, so
 * the request transaction has already committed by the time a tool runs — the
 * inherited context is still visible but points at a dead handle, and every tool
 * query dies 42501. Each tool therefore opens its own short tenant transaction,
 * which also keeps no connection held between tool calls.
 */
export function withTenantScopedTools(
  tools: Record<string, ToolDefinition | undefined>,
  db: Db,
  orgId: string,
): ToolSet {
  const scoped: ToolSet = {};

  for (const [name, definition] of Object.entries(tools)) {
    if (!definition) continue;

    const execute = definition.execute;
    if (typeof execute !== "function") {
      scoped[name] = definition;
      continue;
    }

    scoped[name] = {
      ...definition,
      execute: (input, options) =>
        runInNewTenantTransaction(db, orgId, async () => execute(input, options)),
    };
  }

  return scoped;
}
