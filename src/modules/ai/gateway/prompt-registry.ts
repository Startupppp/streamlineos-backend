import type { z } from "zod";

export interface PromptDefinition<TInput> {
  key: string;
  version: number;
  build: (input: TInput) => { system: string; user: string };
}

export interface RenderedPrompt {
  system: string;
  user: string;
  version: number;
}

type AnyPromptDefinition = PromptDefinition<unknown>;

const registry = new Map<string, AnyPromptDefinition>();

export function definePrompt<TInput>(def: PromptDefinition<TInput>): PromptDefinition<TInput> {
  registry.set(def.key, def as AnyPromptDefinition);
  return def;
}

export function renderPrompt<TInput>(key: string, input: TInput): RenderedPrompt {
  const def = registry.get(key);
  if (!def) throw new Error(`Prompt not found in registry: ${key}`);
  const { system, user } = def.build(input as unknown);
  return { system, user, version: def.version };
}

export type { z };
