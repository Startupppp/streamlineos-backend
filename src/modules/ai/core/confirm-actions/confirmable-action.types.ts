import type { z } from "zod";
import type { ModuleRef } from "@nestjs/core";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { isRecord } from "../../../../common/types/is-record";
import {
  ExternalEffectLedger,
  type ProviderIdempotencyGuarantee,
} from "../../../../common/outbox/external-effect-ledger";

export interface ConfirmableActionContext {
  actor: CurrentUserContext;
  db: Db;
  moduleRef: ModuleRef;
  proposalId: number;
}

export interface ConfirmableActionOutcome {
  result: Record<string, unknown>;
  summary: string;
}

export interface ExternalEffectDeclaration {
  effectType: string;
  providerIdempotency: ProviderIdempotencyGuarantee;
}

export interface ConfirmableActionSpec<TPayload extends z.ZodTypeAny, TServices> {
  action: string;
  permission: string;
  payload: TPayload;
  external?: ExternalEffectDeclaration;
  resolve: (moduleRef: ModuleRef) => TServices;
  execute: (
    payload: z.infer<TPayload>,
    ctx: ConfirmableActionContext,
    services: TServices,
  ) => Promise<ConfirmableActionOutcome>;
}

export function externalEffectKeyFor(action: string, proposalId: number): string {
  return `ai-proposal:${proposalId}:${action}`;
}

export interface ConfirmableActionDefinition<TPayload extends z.ZodTypeAny = z.ZodTypeAny> {
  action: string;
  permission: string;
  payload: TPayload;
  external?: ExternalEffectDeclaration;
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
    external: spec.external,
    resolve: spec.resolve,
    execute: async (payload, ctx) => {
      const services = spec.resolve(ctx.moduleRef);
      const external = spec.external;
      if (external === undefined) return spec.execute(payload, ctx, services);

      const ledger = ctx.moduleRef.get(ExternalEffectLedger, { strict: false });
      const effectKey = externalEffectKeyFor(spec.action, ctx.proposalId);
      let outcome: ConfirmableActionOutcome | undefined;

      const state = await ledger.execute(
        {
          organizationId: ctx.actor.orgId,
          producerEventId: `ai-proposal:${ctx.proposalId}`,
          effectKey,
          effectType: external.effectType,
          providerIdempotency: external.providerIdempotency,
        },
        async () => {
          outcome = await spec.execute(payload, ctx, services);
        },
      );

      if (outcome !== undefined) return outcome;
      if (state === "ALREADY_SUCCEEDED")
        return {
          result: { alreadyDelivered: true },
          summary: `Already delivered — ${spec.action} ran for this confirmation before.`,
        };
      throw new Error(`Confirmable action "${spec.action}" produced no outcome`);
    },
  };
}

const PROPOSE_PARSERS = new Map<string, (input: unknown) => unknown>();

export function registerProposeParsers(
  definitions: readonly ConfirmableActionDefinition[],
): void {
  PROPOSE_PARSERS.clear();
  for (const definition of definitions)
    PROPOSE_PARSERS.set(definition.action, definition.propose);
}

export function assertProposeParsersRegistered(): void {
  if (PROPOSE_PARSERS.size === 0)
    throw new Error(
      "Confirmable action parsers are not registered; nothing loaded confirm-actions/index.ts, so every propose would skip its payload schema.",
    );
}

export function parseProposedPayload(
  action: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const propose = PROPOSE_PARSERS.get(action);
  if (propose === undefined) return input;
  const parsed: unknown = propose(input);
  if (!isRecord(parsed))
    throw new Error(`Confirmable action "${action}" does not parse to an object payload`);
  return parsed;
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
