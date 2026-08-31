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

/**
 * Where an input's valid answers come from, when they are not a literal list.
 *
 * `choices` answers this for the `choice` kind. Nothing answered it for `user`,
 * so an action could say it needed a person without saying WHICH people — and a
 * form built from that declaration would offer the whole organisation while the
 * adapter refused everyone outside the record's own membership.
 *
 * The reference is chosen by the adapter from the record being acted on, never
 * supplied by the caller: a client that could name the source could widen it.
 */
export interface EntityActionOptionSource {
  from: EntityReference;
}

export interface EntityOption {
  value: string;
  label: string;
  imageUrl?: string | null;
}

export interface EntityActionInput {
  name: string;
  kind: EntityActionInputKind;
  required: boolean;
  choices?: string[];
  options?: EntityActionOptionSource;
}

export interface EntityAction {
  id: string;
  label: string;
  inputs: EntityActionInput[];
}

export interface EntityActor {
  orgId: string;
  userId: string;
  membershipId?: number;
  isOrgOwner: boolean;
}

export type EntityActionFailure = "forbidden" | "not-found" | "invalid";

export type EntityActionResult =
  | { ok: true; message: string | null; data: Record<string, unknown> }
  | { ok: false; reason: EntityActionFailure };

export interface EntityAdapter {
  readonly moduleKey: string;
  readonly types: readonly string[];
  // Pure: no writes, no observable side effects; a miss returns unresolved, never forbidden.
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
  /**
   * The candidates an option source resolves to. Optional: an adapter that
   * declares no option source never needs it.
   */
  optionsFor?(
    actor: EntityActor,
    reference: EntityReference,
  ): Promise<EntityOption[]>;
}

export interface ModuleEntitlementPort {
  isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean>;
}

export const ENTITY_ADAPTERS = Symbol("ENTITY_ADAPTERS");
export const ENTITY_MODULE_ENTITLEMENT = Symbol("ENTITY_MODULE_ENTITLEMENT");

export function unresolved(reference: EntityReference): EntityResolution {
  return { status: "unresolved", reference };
}
