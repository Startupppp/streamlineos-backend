import { tool, type ToolSet } from "ai";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../../db/drizzle.module";
import type { DataScope } from "../../../access/access.types";
import type { AccessSnapshot } from "../../../access/access.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AskOsActor } from "../services/ask-os-actor";
import { denied } from "./ask-os-tool.types";
import type {
  AskOsToolDefinition,
  AskOsToolRunContext,
  ToolOutcome,
} from "./ask-os-tool.types";
import type { AskOsDirective } from "../streaming/ask-os-directive";

export interface AskOsToolsetInput {
  db: Db;
  actor: AskOsActor;
  caller: CurrentUserContext;
  snapshot: AccessSnapshot;
  definitions: readonly AskOsToolDefinition[];
  onDirective?: (directive: AskOsDirective) => void;
}

export function isToolAvailable(
  definition: AskOsToolDefinition,
  snapshot: AccessSnapshot,
): boolean {
  if (definition.module && snapshot.modules[definition.module] === false) return false;
  if (!definition.permission) return true;
  const scope = snapshot.scopes[definition.permission];
  return scope !== undefined && scope !== "none";
}

export function availableDefinitions(
  definitions: readonly AskOsToolDefinition[],
  snapshot: AccessSnapshot,
): AskOsToolDefinition[] {
  return definitions.filter((definition) => isToolAvailable(definition, snapshot));
}

export function assertUniqueKeys(definitions: readonly AskOsToolDefinition[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.key)) duplicates.add(definition.key);
    seen.add(definition.key);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate Ask OS tool keys: ${[...duplicates].sort().join(", ")}`);
  }
}

function scopeFor(definition: AskOsToolDefinition, snapshot: AccessSnapshot): DataScope {
  if (!definition.permission) return "all";
  return snapshot.scopes[definition.permission] ?? "none";
}

export function toJsonSafe(value: Record<string, unknown>): Record<string, unknown> {
  try {
    const encoded: unknown = JSON.parse(JSON.stringify(value));
    if (typeof encoded === "object" && encoded !== null && !Array.isArray(encoded))
      return { ...encoded };
    return { ok: false, failed: true, reason: "The tool returned a non-object result." };
  } catch {
    return { ok: false, failed: true, reason: "The tool result could not be serialized." };
  }
}

export function renderOutcome(outcome: ToolOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "data":
      return { ok: true, data: outcome.data };
    case "empty":
      return outcome.hint === undefined
        ? { ok: true, empty: true, subject: outcome.subject }
        : { ok: true, empty: true, subject: outcome.subject, hint: outcome.hint };
    case "denied":
      return { ok: false, denied: true, reason: outcome.reason };
    case "needs-connection":
      return {
        ok: false,
        requiresConnection: true,
        toolkit: outcome.toolkit,
        reason: outcome.reason,
        summary: outcome.summary,
      };
    case "needs-confirmation":
      return {
        requiresConfirmation: true,
        proposalId: outcome.proposalId,
        token: outcome.token,
        action: outcome.action,
        summary: outcome.summary,
        preview: outcome.preview,
        ...(outcome.expiresAt !== undefined ? { expiresAt: outcome.expiresAt } : {}),
      };
    case "failed":
      return { ok: false, failed: true, reason: outcome.reason };
    default: {
      void (outcome satisfies never);
      return { ok: false, failed: true, reason: "Unknown tool outcome" };
    }
  }
}

export function buildAskOsToolset(input: AskOsToolsetInput): ToolSet {
  const { db, actor, caller, snapshot, definitions, onDirective } = input;
  assertUniqueKeys(definitions);

  const toolset: ToolSet = {};
  for (const definition of availableDefinitions(definitions, snapshot)) {
    const runContext: AskOsToolRunContext = {
      actor,
      caller,
      scope: scopeFor(definition, snapshot),
      scopes: snapshot.scopes,
      modules: snapshot.modules,
    };

    toolset[definition.key] = tool({
      description: definition.description,
      inputSchema: definition.input,
      execute: async (rawInput: unknown) => {
        try {
          return toJsonSafe(
            await runInNewTenantTransaction(db, actor.orgId, async () => {
              if (runContext.scope === "none" && definition.permission) {
                return renderOutcome(denied(definition.permission));
              }
              const parsed: unknown = definition.input.parse(rawInput);
              const outcome = await definition.run(parsed, runContext);
              if (onDirective !== undefined) {
                if (outcome.kind === "needs-confirmation") {
                  onDirective({
                    kind: "confirm-action",
                    proposalId: outcome.proposalId,
                    token: outcome.token,
                    action: outcome.action,
                    summary: outcome.summary,
                    preview: outcome.preview,
                  });
                  return { status: "pending_confirmation", summary: outcome.summary };
                }
                if (outcome.kind === "needs-connection") {
                  onDirective({
                    kind: "connect-integration",
                    toolkit: outcome.toolkit,
                    reason: outcome.reason,
                    summary: outcome.summary,
                  });
                  return { status: "connection_required", summary: outcome.summary };
                }
              }
              return renderOutcome(outcome);
            }),
          );
        } catch (error) {
          return toJsonSafe(
            renderOutcome({
              kind: "failed",
              reason: error instanceof Error ? error.message : "The tool could not complete.",
            }),
          );
        }
      },
    });
  }

  return toolset;
}
