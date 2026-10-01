import type { Type } from "@nestjs/common";
import request from "supertest";
import { createAuthzHarness, type AuthzHarness } from "../../../helpers/authz-deny-harness";
import { outcomeOfStatus } from "../matrix-runner";
import type { Observation } from "../matrix.types";
import { actorFor, resolvedScopes, userOf, type Standing } from "../standings";
import type { WorldDb } from "../world-db";

export interface HttpProbe {
  readonly controllers: readonly Type<unknown>[];
  readonly verb: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly body?: object;
  readonly permissionKey: string;
  readonly standing: Standing;
  readonly orgId: string;
  readonly moduleDisabled?: boolean;
}

const harnesses = new Map<string, Promise<AuthzHarness>>();

function harnessFor(controllers: readonly Type<unknown>[]): Promise<AuthzHarness> {
  const key = controllers.map((controller) => controller.name).join("+");
  const existing = harnesses.get(key);
  if (existing !== undefined) return existing;
  const created = createAuthzHarness(controllers);
  harnesses.set(key, created);
  return created;
}

export async function closeHttpHarnesses(): Promise<void> {
  const open = [...harnesses.values()];
  harnesses.clear();
  for (const harness of open) await (await harness).close();
}

export async function probeHttp(world: WorldDb, probe: HttpProbe): Promise<Observation> {
  const harness = await harnessFor(probe.controllers);
  harness.reset();
  harness.actAs(actorFor(probe.standing, probe.orgId));
  harness.holdScopes(await resolvedScopes(world, probe.orgId, userOf(probe.standing, probe.orgId)));
  if (probe.moduleDisabled === true) harness.disableModule("org-disabled");
  const pending = request(harness.server())[probe.verb](probe.path).set("Content-Type", "application/json");
  const response = probe.body === undefined ? await pending : await pending.send(probe.body);
  const asked = harness.keysAsked();
  return {
    outcome: outcomeOfStatus(response.status),
    checks: probe.moduleDisabled === true ? {} : { routeAskedForItsKey: asked.includes(probe.permissionKey) },
  };
}
