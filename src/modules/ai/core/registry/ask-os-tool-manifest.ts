import { jsonSchema, type Schema } from "ai";
import { z } from "zod";
import type { AskOsToolDefinition } from "./ask-os-tool.types";
import { isRecord } from "../../../../common/types/is-record";

const SAFE_INTEGER = 9007199254740991;

function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (!isRecord(node)) return node;

  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "maximum" && value === SAFE_INTEGER) continue;
    if (key === "minimum" && value === -SAFE_INTEGER) continue;
    pruned[key] = prune(value);
  }
  return pruned;
}

export function toModelSchema(input: z.ZodTypeAny): Record<string, unknown> {
  const pruned = prune(z.toJSONSchema(input));
  return isRecord(pruned) ? pruned : {};
}

const cache = new WeakMap<AskOsToolDefinition, Schema<unknown>>();

export function manifestSchema(definition: AskOsToolDefinition): Schema<unknown> {
  const existing = cache.get(definition);
  if (existing !== undefined) return existing;
  const built = jsonSchema<unknown>(toModelSchema(definition.input));
  cache.set(definition, built);
  return built;
}
