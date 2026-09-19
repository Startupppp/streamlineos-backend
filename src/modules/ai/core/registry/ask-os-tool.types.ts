import type { z } from "zod";
import { permissionAreaLabel } from "../../../../common/rbac/module-vocabulary";
import type { DataScope } from "../../../access/access.types";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { IntegrationToolkit } from "../../../../db/schema";

export type ToolOutcome<T = unknown> =
  | { kind: "data"; data: T }
  | { kind: "empty"; subject: string; hint?: string }
  | { kind: "denied"; permission: string; reason: string }
  | { kind: "needs-connection"; toolkit: IntegrationToolkit; reason: "no-connection" | "needs-reauth"; summary: string }
  | { kind: "needs-confirmation"; proposalId: number; token: string; action: string; summary: string; preview: Record<string, unknown>; expiresAt?: Date }
  | { kind: "failed"; reason: string };

export interface AskOsToolRunContext {
  actor: AskOsActor;
  caller: CurrentUserContext;
  scope: DataScope;
  scopes: Readonly<Record<string, DataScope>>;
  modules: Readonly<Record<string, boolean>>;
}

export interface AskOsToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  key: string;
  description: string;
  input: TInput;
  permission?: string;
  module?: string;
  run: (input: z.infer<TInput>, ctx: AskOsToolRunContext) => Promise<ToolOutcome>;
}

export interface AskOsToolProvider {
  tools(): AskOsToolDefinition[];
}

export function defineTool<TInput extends z.ZodTypeAny>(
  definition: AskOsToolDefinition<TInput>,
): AskOsToolDefinition<TInput> {
  return definition;
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
  return { kind: "needs-confirmation", ...proposal };
}
