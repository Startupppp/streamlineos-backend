import type { Type } from "@nestjs/common";
import request from "supertest";
import { createAuthzHarness, type AuthzHarness } from "../../../helpers/authz-deny-harness";
import { outcomeOfStatus } from "../matrix-runner";
import type { Observation, ObservedOutcome } from "../matrix.types";
import { actorFor, resolvedScopes, userOf, type Standing, type Variant } from "../standings";
import type { WorldDb } from "../world-db";
import type { DataScope } from "src/modules/access/access.types";

export interface RealProvider {
  readonly provide: Type<unknown> | string | symbol;
  readonly useValue: object;
}

export interface HttpProbe {
  readonly controllers: readonly Type<unknown>[];
  readonly services?: readonly RealProvider[];
  readonly verb: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly body?: object;
  readonly headers?: Readonly<Record<string, string>>;
  readonly permissionKey?: string;
  readonly standing: Standing;
  readonly variant?: Variant;
  readonly orgId: string;
  readonly moduleDisabled?: boolean;
  readonly serviceReads?: string;
  readonly scopeOverrides?: Readonly<Record<string, DataScope>>;
  readonly wiring?: string;
}

export interface HttpExchange {
  readonly status: number;
  readonly body: unknown;
  readonly outcome: ObservedOutcome;
  readonly asked: readonly string[];
  readonly guardPassed: boolean;
  readonly readMark: number;
}

const harnesses = new Map<string, Promise<AuthzHarness>>();

function tokenName(token: RealProvider["provide"]): string {
  return typeof token === "function" ? token.name : String(token);
}

function harnessFor(controllers: readonly Type<unknown>[], services: readonly RealProvider[], wiring = ""): Promise<AuthzHarness> {
  const key = [...controllers.map((controller) => controller.name), ...services.map((service) => `real:${tokenName(service.provide)}`), wiring].join("+");
  const existing = harnesses.get(key);
  if (existing !== undefined) return existing;
  const created = createAuthzHarness(controllers, { providers: services });
  harnesses.set(key, created);
  return created;
}

export async function closeHttpHarnesses(): Promise<void> {
  const open = [...harnesses.values()];
  harnesses.clear();
  for (const harness of open) await (await harness).close();
}

export async function harnessOf(probe: Pick<HttpProbe, "controllers" | "services" | "wiring">): Promise<AuthzHarness> {
  return harnessFor(probe.controllers, probe.services ?? [], probe.wiring);
}

export async function sendHttp(world: WorldDb, probe: HttpProbe): Promise<HttpExchange> {
  const harness = await harnessFor(probe.controllers, probe.services ?? [], probe.wiring);
  harness.reset();
  harness.actAs(actorFor(probe.standing, probe.orgId, probe.variant));
  const scopes = {
    ...(await resolvedScopes(world, probe.orgId, userOf(probe.standing, probe.orgId, probe.variant))),
    ...probe.scopeOverrides,
  };
  harness.holdScopes(scopes);
  if (probe.moduleDisabled === true) harness.disableModule("org-disabled");
  const readMark = world.reads.length;
  let pending = request(harness.server())[probe.verb](probe.path).set("Content-Type", "application/json");
  for (const [name, value] of Object.entries(probe.headers ?? {})) pending = pending.set(name, value);
  const response = probe.body === undefined ? await pending : await pending.send(probe.body);
  const outcome = outcomeOfStatus(response.status);
  return {
    status: response.status,
    body: response.body,
    outcome: outcome.startsWith("unexpected") ? `unexpected:${response.status} ${JSON.stringify(response.body).slice(0, 300)}` : outcome,
    asked: harness.keysAsked(),
    guardPassed: probe.permissionKey === undefined || (scopes[probe.permissionKey] ?? "none") !== "none",
    readMark,
  };
}

export async function probeHttp(world: WorldDb, probe: HttpProbe): Promise<Observation> {
  const exchange = await sendHttp(world, probe);
  if (probe.moduleDisabled === true) return { outcome: exchange.outcome };
  const checks: Record<string, boolean> = {};
  if (probe.permissionKey !== undefined) checks.routeAskedForItsKey = exchange.asked.includes(probe.permissionKey);
  const table = probe.serviceReads;
  if (table !== undefined && exchange.guardPassed)
    checks.realServiceReadTheWorld = world.reads.slice(exchange.readMark).some((read) => read.table === table);
  if (table !== undefined && !exchange.guardPassed) checks.guardRefusedBeforeTheService = world.reads.length === exchange.readMark;
  return { outcome: exchange.outcome, checks };
}
