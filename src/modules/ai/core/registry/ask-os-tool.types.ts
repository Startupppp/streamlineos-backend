import type { z } from "zod";
import { permissionAreaLabel } from "../../../../common/rbac/module-vocabulary";
import type { ScopedRead } from "../../../access/scoped-read";
import type { AskOsToolReader } from "../ask-os-tool-scope";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { IntegrationToolkit } from "../../../../db/schema";
import { CONFIRMABLE_ACTIONS, CONFIRM_ACTION_PERMISSION } from "../confirm-actions";

const KNOWN_CONFIRMABLE_ACTIONS: ReadonlySet<string> = new Set(CONFIRMABLE_ACTIONS);

export type ToolOutcome<T = unknown> =
  | { kind: "data"; data: T }
  | { kind: "empty"; subject: string; hint?: string }
  | { kind: "denied"; permission: string; reason: string }
  | { kind: "needs-connection"; toolkit: IntegrationToolkit; reason: "no-connection" | "needs-reauth"; summary: string }
  | { kind: "needs-confirmation"; proposalId: number; token: string; action: string; summary: string; preview: Record<string, unknown>; expiresAt?: Date }
  | { kind: "ambiguous"; reason: string; candidates: readonly AmbiguousCandidate[] }
  | { kind: "failed"; reason: string };

export interface AmbiguousCandidate {
  label: string;
  hint?: string;
}

export interface AskOsToolRunContext {
  actor: AskOsActor;
  caller: CurrentUserContext;
  read: ScopedRead;
  readFor: AskOsToolReader;
  modules: Readonly<Record<string, boolean>>;
}

export interface AskOsToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  key: string;
  description: string;
  input: TInput;
  permission?: string;
  confirms?: string;
  module?: string;
  ownsTransaction?: true;
  run: (input: z.infer<TInput>, ctx: AskOsToolRunContext) => Promise<ToolOutcome>;
}

export type AskOsToolSpec<TInput extends z.ZodTypeAny = z.ZodTypeAny> =
  | (Omit<AskOsToolDefinition<TInput>, "confirms"> & { confirms?: never })
  | (Omit<AskOsToolDefinition<TInput>, "permission" | "confirms"> & {
      confirms: string;
      permission?: never;
    });

export interface AskOsToolProvider {
  tools(): AskOsToolDefinition[];
}

export function defineTool<TInput extends z.ZodTypeAny>(
  spec: AskOsToolSpec<TInput>,
): AskOsToolDefinition<TInput> {
  if (spec.confirms === undefined) return spec;
  const permission = CONFIRM_ACTION_PERMISSION[spec.confirms];
  if (permission === undefined)
    throw new Error(
      `Ask OS tool "${spec.key}" declares confirms: "${spec.confirms}", which is not a registered confirmable action — add it to CONFIRMABLE_ACTION_DEFINITIONS in confirm-actions/`,
    );
  return { ...spec, permission };
}

export function data<T>(value: T): ToolOutcome<T> {
  return { kind: "data", data: value };
}

export function empty(subject: string, hint?: string): ToolOutcome<never> {
  return hint === undefined
    ? { kind: "empty", subject }
    : { kind: "empty", subject, hint };
}

export function failed(reason: string): ToolOutcome<never> {
  return { kind: "failed", reason };
}

export function ambiguous(
  reason: string,
  candidates: readonly AmbiguousCandidate[],
): ToolOutcome<never> {
  return { kind: "ambiguous", reason, candidates };
}

export function toolDenialReason(permission: string): string {
  return `Permission denied: you do not have access to ${permissionAreaLabel(permission)} data.`;
}

export function denied(permission: string): ToolOutcome<never> {
  return { kind: "denied", permission, reason: toolDenialReason(permission) };
}

export function needsConnection(
  toolkit: IntegrationToolkit,
  reason: "no-connection" | "needs-reauth",
  summary: string,
): ToolOutcome<never> {
  return { kind: "needs-connection", toolkit, reason, summary };
}

export function needsConfirmation(proposal: {
  proposalId: number;
  token: string;
  action: string;
  summary: string;
  preview: Record<string, unknown>;
  expiresAt?: Date;
}): ToolOutcome<never> {
  if (!KNOWN_CONFIRMABLE_ACTIONS.has(proposal.action))
    throw new Error(
      `needsConfirmation called with unregistered action "${proposal.action}" — add it to CONFIRMABLE_ACTION_DEFINITIONS in confirm-actions/`,
    );
  return { kind: "needs-confirmation", ...proposal };
}
