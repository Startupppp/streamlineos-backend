import type { z } from "zod";
import type { ModuleRef } from "@nestjs/core";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { isRecord } from "../../../../common/types/is-record";

export interface ConfirmableActionContext {
  actor: CurrentUserContext;
  db: Db;
  moduleRef: ModuleRef;
}

export interface ConfirmableActionOutcome {
  result: Record<string, unknown>;
  summary: string;
}

export interface ConfirmableActionSpec<TPayload extends z.ZodTypeAny, TServices> {
  action: string;
  permission: string;
  payload: TPayload;
  resolve: (moduleRef: ModuleRef) => TServices;
  execute: (
    payload: z.infer<TPayload>,
    ctx: ConfirmableActionContext,
    services: TServices,
  ) => Promise<ConfirmableActionOutcome>;
}

export interface ConfirmableActionDefinition<TPayload extends z.ZodTypeAny = z.ZodTypeAny> {
  action: string;
  permission: string;
  payload: TPayload;
  propose: (input: unknown) => z.infer<TPayload>;
  resolve: (moduleRef: ModuleRef) => unknown;
  execute: (
    payload: z.infer<TPayload>,
    ctx: ConfirmableActionContext,
  ) => Promise<ConfirmableActionOutcome>;
}

export function droppedPayloadFields(input: unknown, parsed: unknown): string[] {
  if (!isRecord(input) || !isRecord(parsed)) return [];
  return Object.keys(input)
    .filter((key) => input[key] !== undefined && !(key in parsed))
    .sort();
}

export function defineConfirmableAction<TPayload extends z.ZodTypeAny, TServices>(
  spec: ConfirmableActionSpec<TPayload, TServices>,
): ConfirmableActionDefinition<TPayload> {
  return {
    action: spec.action,
    permission: spec.permission,
    payload: spec.payload,
    propose: (input) => {
      const parsed: z.infer<TPayload> = spec.payload.parse(input);
      const dropped = droppedPayloadFields(input, parsed);
      if (dropped.length > 0)
        throw new Error(
          `Confirmable action "${spec.action}" would drop payload field(s) the card shows: ${dropped.join(", ")}`,
        );
      return parsed;
    },
    resolve: spec.resolve,
    execute: (payload, ctx) => spec.execute(payload, ctx, spec.resolve(ctx.moduleRef)),
  };
}

export function assertUniqueActions(
  definitions: readonly ConfirmableActionDefinition[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.action)) duplicates.add(definition.action);
    seen.add(definition.action);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate confirmable action keys: ${[...duplicates].sort().join(", ")}`,
    );
  }
}

export function assertResolvableActionServices(
  moduleRef: ModuleRef,
  definitions: readonly ConfirmableActionDefinition[],
): void {
  const unresolved: string[] = [];
  for (const definition of definitions) {
    try {
      definition.resolve(moduleRef);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      unresolved.push(`${definition.action}: ${reason}`);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Confirmable actions cannot resolve their services: ${unresolved.join("; ")}`,
    );
  }
}
