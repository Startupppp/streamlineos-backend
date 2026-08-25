import type { WorkflowDefinition } from "./workflow.types";

/**
 * The workflows this deployment knows how to run.
 *
 * A run whose name is not registered is not a failure to retry — no amount of
 * waiting will make the handler appear — so the runner dead-letters it at once
 * rather than burning five attempts discovering the same thing.
 */
export class WorkflowRegistry {
  private readonly byName = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition): void {
    if (!definition.name) throw new Error("workflow: name must be a non-empty string");

    if (this.byName.has(definition.name))
      throw new Error(
        `workflow: "${definition.name}" is already registered. Two handlers under one name means a run silently executes whichever loaded last.`,
      );

    this.byName.set(definition.name, definition);
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.byName.get(name);
  }

  /** Definitions started by an outbox event of this type. */
  triggeredBy(eventType: string): WorkflowDefinition[] {
    return [...this.byName.values()].filter((definition) =>
      definition.triggers?.includes(eventType),
    );
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  clear(): void {
    this.byName.clear();
  }
}
