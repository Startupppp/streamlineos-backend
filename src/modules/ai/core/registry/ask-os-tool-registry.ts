import { Logger } from "@nestjs/common";
import { tool, type ToolSet } from "ai";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessSnapshot } from "../../../access/access.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AskOsActor } from "../services/ask-os-actor";
import { askOsToolRead, askOsToolReader } from "../ask-os-tool-scope";
import { denied } from "./ask-os-tool.types";
import { manifestSchema } from "./ask-os-tool-manifest";
import type {
  AskOsToolDefinition,
  AskOsToolRunContext,
  ToolOutcome,
} from "./ask-os-tool.types";
import type { AskOsDirective } from "../streaming/ask-os-directive";
import { isRecord } from "../../../../common/types/is-record";

const logger = new Logger("AskOsTool");

export const ACTION_LABELS: Record<string, { title: string; confirmLabel: string }> = {
  "email.send": { title: "Send email", confirmLabel: "Send" },
  "mail.send": { title: "Send email", confirmLabel: "Send" },
  "mail.reply": { title: "Reply to email", confirmLabel: "Reply" },
  "mail.archive": { title: "Archive email", confirmLabel: "Archive" },
  "chat.postChannel": { title: "Post to channel", confirmLabel: "Post" },
  "chat.sendDirect": { title: "Send direct message", confirmLabel: "Send" },
  "hr.grantRecognition": { title: "Send kudos", confirmLabel: "Send" },
  "hr.grantBonus": { title: "Grant bonus", confirmLabel: "Grant" },
  "crm.createLead": { title: "Create lead", confirmLabel: "Create" },
  "crm.logActivity": { title: "Log activity", confirmLabel: "Log" },
  "crm.updateLeadStatus": { title: "Update lead status", confirmLabel: "Update" },
  "ticket.assign": { title: "Assign ticket", confirmLabel: "Assign" },
  "ticket.moveToCycle": { title: "Move to cycle", confirmLabel: "Move" },
  "calendar.createEvent": { title: "Create event", confirmLabel: "Create" },
  "ticket.create": { title: "Create ticket", confirmLabel: "Create" },
  "ticket.updateStatus": { title: "Update status", confirmLabel: "Update" },
  "ticket.addComment": { title: "Add comment", confirmLabel: "Comment" },
  "calendar.createReminder": { title: "Set reminder", confirmLabel: "Remind" },
  "calendar.scheduleMeeting": { title: "Schedule meeting", confirmLabel: "Schedule" },
  "self.applyLeave": { title: "Request leave", confirmLabel: "Submit" },
  "self.submitExpense": { title: "Submit expense", confirmLabel: "Submit" },
  "self.logTimesheet": { title: "Log time", confirmLabel: "Log" },
  "self.submitReferral": { title: "Submit referral", confirmLabel: "Submit" },
  "self.applyToJobOpening": { title: "Apply for job opening", confirmLabel: "Submit" },
};

export function labelledConfirmDirective(
  outcome: Extract<ToolOutcome, { kind: "needs-confirmation" }>,
): Extract<AskOsDirective, { kind: "confirm-action" }> {
  const labels = ACTION_LABELS[outcome.action];
  return {
    kind: "confirm-action",
    proposalId: outcome.proposalId,
    token: outcome.token,
    action: outcome.action,
    summary: outcome.summary,
    preview: outcome.preview,
    ...(outcome.expiresAt !== undefined ? { expiresAt: outcome.expiresAt.toISOString() } : {}),
    ...(labels !== undefined ? { title: labels.title, confirmLabel: labels.confirmLabel } : {}),
  };
}

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
  if (definition.module && !snapshot.modules[definition.module]) return false;
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

function droppedInputPaths(raw: unknown, parsed: unknown, prefix = ""): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed))
    return raw.flatMap((value, index) =>
      droppedInputPaths(value, parsed[index], `${prefix}[${String(index)}]`),
    );
  if (!isRecord(raw) || !isRecord(parsed)) return [];

  return Object.keys(raw).flatMap((key) => {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (!(key in parsed)) return [path];
    return droppedInputPaths(raw[key], parsed[key], path);
  });
}

export function parseToolInput<TInput>(
  schema: { parse: (value: unknown) => TInput },
  rawInput: unknown,
): TInput {
  const parsed = schema.parse(rawInput);
  const dropped = droppedInputPaths(rawInput, parsed);
  if (dropped.length > 0)
    throw new Error(`Tool input contains undeclared field(s): ${dropped.sort().join(", ")}`);
  return parsed;
}

export function safeToolFailureReason(_error: unknown): string {
  return "The tool could not complete.";
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
    case "ambiguous":
      return {
        ok: false,
        ambiguous: true,
        reason: outcome.reason,
        candidates: outcome.candidates,
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
  const readFor = askOsToolReader(actor, snapshot);
  for (const definition of availableDefinitions(definitions, snapshot)) {
    const runContext: AskOsToolRunContext = {
      actor,
      caller,
      read: askOsToolRead(actor, snapshot, definition.permission),
      readFor,
      modules: snapshot.modules,
    };

    toolset[definition.key] = tool({
      description: definition.description,
      inputSchema: manifestSchema(definition),
      execute: async (rawInput: unknown) => {
        const inTenantScope = async <T>(body: () => Promise<T>): Promise<T> =>
          definition.ownsTransaction === true
            ? body()
            : runInNewTenantTransaction(db, actor.orgId, body);

        try {
          return toJsonSafe(
            await inTenantScope(async () => {
              if (runContext.read.denied && definition.permission) {
                return renderOutcome(denied(definition.permission));
              }
              const parsed: unknown = parseToolInput(definition.input, rawInput);
              const outcome = await definition.run(parsed, runContext);
              if (outcome.kind === "needs-confirmation") {
                onDirective?.(labelledConfirmDirective(outcome));
                return { status: "pending_confirmation", summary: outcome.summary };
              }
              if (outcome.kind === "needs-connection") {
                onDirective?.({
                  kind: "connect-integration",
                  toolkit: outcome.toolkit,
                  reason: outcome.reason,
                  summary: outcome.summary,
                });
                return { status: "connection_required", summary: outcome.summary };
              }
              return renderOutcome(outcome);
            }),
          );
        } catch (error) {
          logger.error(
            `tool ${definition.key} failed for org ${actor.orgId}`,
            error instanceof Error ? error.stack : String(error),
          );
          return toJsonSafe(
            renderOutcome({
              kind: "failed",
              reason: safeToolFailureReason(error),
            }),
          );
        }
      },
    });
  }

  return toolset;
}
