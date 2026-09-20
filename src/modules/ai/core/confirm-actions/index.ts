import { Injectable, type OnModuleInit } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { BUILD_CONFIRM_ACTIONS } from "./build-confirm-actions";
import { COMMS_CONFIRM_ACTIONS } from "./comms-confirm-actions";
import { CRM_CONFIRM_ACTIONS } from "./crm-confirm-actions";
import { SELF_CONFIRM_ACTIONS } from "./self-confirm-actions";
import { WORKSPACE_CONFIRM_ACTIONS } from "./workspace-confirm-actions";
import {
  assertResolvableActionServices,
  assertUniqueActions,
  type ConfirmableActionDefinition,
} from "./confirmable-action.types";
import { isRecord } from "../../../../common/types/is-record";

export const CONFIRMABLE_ACTION_DEFINITIONS: readonly ConfirmableActionDefinition[] = [
  ...BUILD_CONFIRM_ACTIONS,
  ...COMMS_CONFIRM_ACTIONS,
  ...CRM_CONFIRM_ACTIONS,
  ...SELF_CONFIRM_ACTIONS,
  ...WORKSPACE_CONFIRM_ACTIONS,
];

assertUniqueActions(CONFIRMABLE_ACTION_DEFINITIONS);

const BY_ACTION = new Map<string, ConfirmableActionDefinition>(
  CONFIRMABLE_ACTION_DEFINITIONS.map((definition) => [definition.action, definition]),
);

export const CONFIRMABLE_ACTIONS: readonly string[] = CONFIRMABLE_ACTION_DEFINITIONS.map(
  (definition) => definition.action,
);

export const CONFIRM_ACTION_PERMISSION: Readonly<Record<string, string>> =
  Object.fromEntries(
    CONFIRMABLE_ACTION_DEFINITIONS.map((definition) => [
      definition.action,
      definition.permission,
    ]),
  );

export function findConfirmableAction(
  action: string,
): ConfirmableActionDefinition | undefined {
  return BY_ACTION.get(action);
}

export function parseProposedPayload(
  action: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const definition = BY_ACTION.get(action);
  if (definition === undefined)
    throw new Error(`Unknown confirmable action: ${action}`);
  const parsed: unknown = definition.propose(input);
  if (!isRecord(parsed))
    throw new Error(`Confirmable action "${action}" does not parse to an object payload`);
  return parsed;
}

@Injectable()
export class ConfirmableActionServicesCheck implements OnModuleInit {
  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    assertResolvableActionServices(this.moduleRef, CONFIRMABLE_ACTION_DEFINITIONS);
  }
}
