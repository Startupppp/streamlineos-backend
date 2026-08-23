import { Inject, Injectable } from "@nestjs/common";
import {
  ENTITY_ADAPTERS,
  ENTITY_MODULE_ENTITLEMENT,
  unresolved,
  type EntityAction,
  type EntityActionResult,
  type EntityActor,
  type EntityAdapter,
  type EntityReference,
  type EntityResolution,
  type ModuleEntitlementPort,
} from "./entity-reference.types";

@Injectable()
export class EntityReferenceService {
  private readonly byType = new Map<string, EntityAdapter>();

  constructor(
    @Inject(ENTITY_ADAPTERS) adapters: EntityAdapter[],
    @Inject(ENTITY_MODULE_ENTITLEMENT)
    private readonly entitlement: ModuleEntitlementPort,
  ) {
    for (const adapter of adapters)
      for (const type of adapter.types) this.byType.set(type, adapter);
  }

  isKnownType(type: string): boolean {
    return this.byType.has(type);
  }

  knownTypes(): string[] {
    return [...this.byType.keys()];
  }

  async resolve(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityResolution[]> {
    return this.dispatch(actor, references, unresolved, (adapter, batch) =>
      adapter.resolve(actor, batch),
    );
  }

  async withResolvedReferences<
    T extends { metadata: Record<string, unknown> | null },
  >(actor: EntityActor, messages: T[]): Promise<T[]> {
    const flat: { message: number; reference: EntityReference }[] = [];

    messages.forEach((message, index) => {
      const raw = message.metadata?.["entities"];
      if (!Array.isArray(raw)) return;
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const { type, id } = entry as { type?: unknown; id?: unknown };
        if (typeof type !== "string" || typeof id !== "string") continue;
        flat.push({ message: index, reference: { type, id } });
      }
    });

    if (flat.length === 0) return messages;

    const resolutions = await this.resolve(
      actor,
      flat.map((entry) => entry.reference),
    );

    const byMessage = new Map<number, unknown[]>();
    flat.forEach((entry, position) => {
      const resolution = resolutions[position];
      const list = byMessage.get(entry.message) ?? [];
      list.push(
        resolution?.status === "resolved"
          ? { ...entry.reference, card: resolution.card }
          : { ...entry.reference, card: null },
      );
      byMessage.set(entry.message, list);
    });

    return messages.map((message, index) => {
      const entities = byMessage.get(index);
      if (!entities) return message;
      return { ...message, metadata: { ...message.metadata, entities } };
    });
  }

  async actionsFor(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityAction[][]> {
    return this.dispatch(
      actor,
      references,
      () => [],
      (adapter, batch) => adapter.actionsFor(actor, batch),
    );
  }

  async submitAction(
    actor: EntityActor,
    reference: EntityReference,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const adapter = this.byType.get(reference.type);
    if (!adapter) return { ok: false, reason: "not-found" };

    const enabled = await this.entitlement.isModuleEnabled(
      actor.orgId,
      adapter.moduleKey,
    );
    if (!enabled) return { ok: false, reason: "not-found" };

    return adapter.submitAction(actor, reference, actionId, input);
  }

  private async dispatch<T>(
    actor: EntityActor,
    references: EntityReference[],
    fallback: (reference: EntityReference) => T,
    run: (adapter: EntityAdapter, batch: EntityReference[]) => Promise<T[]>,
  ): Promise<T[]> {
    const results = references.map(fallback);
    const batches = new Map<
      EntityAdapter,
      { reference: EntityReference; index: number }[]
    >();

    references.forEach((reference, index) => {
      const adapter = this.byType.get(reference.type);
      if (!adapter) return;
      const batch = batches.get(adapter) ?? [];
      batch.push({ reference, index });
      batches.set(adapter, batch);
    });

    await Promise.all(
      [...batches].map(async ([adapter, batch]) => {
        const enabled = await this.entitlement.isModuleEnabled(
          actor.orgId,
          adapter.moduleKey,
        );
        if (!enabled) return;
        const resolved = await run(
          adapter,
          batch.map((entry) => entry.reference),
        );
        batch.forEach((entry, position) => {
          const value = resolved[position];
          if (value !== undefined) results[entry.index] = value;
        });
      }),
    );

    return results;
  }
}
