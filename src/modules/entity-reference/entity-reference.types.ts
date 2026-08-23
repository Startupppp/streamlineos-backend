export interface EntityReference {
  type: string;
  id: string;
}

export interface EntityCard {
  type: string;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  href: string;
}

export type EntityResolution =
  | { status: "resolved"; card: EntityCard }
  | { status: "unresolved"; reference: EntityReference };

export type EntityActionInputKind = "text" | "date" | "user" | "choice";

export interface EntityActionInput {
  name: string;
  kind: EntityActionInputKind;
  required: boolean;
  choices?: string[];
}

export interface EntityAction {
  id: string;
  label: string;
  inputs: EntityActionInput[];
}

export interface EntityActor {
  orgId: string;
  userId: string;
  isOrgOwner: boolean;
}

export type EntityActionFailure = "forbidden" | "not-found" | "invalid";

export type EntityActionResult =
  | { ok: true; message: string | null; data: Record<string, unknown> }
  | { ok: false; reason: EntityActionFailure };

export interface EntityAdapter {
  readonly moduleKey: string;
  readonly types: readonly string[];
  resolve(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityResolution[]>;
  actionsFor(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityAction[][]>;
  submitAction(
    actor: EntityActor,
    reference: EntityReference,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult>;
}

export interface ModuleEntitlementPort {
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
}

export const ENTITY_ADAPTERS = Symbol("ENTITY_ADAPTERS");
export const ENTITY_MODULE_ENTITLEMENT = Symbol("ENTITY_MODULE_ENTITLEMENT");

export function unresolved(reference: EntityReference): EntityResolution {
  return { status: "unresolved", reference };
}
