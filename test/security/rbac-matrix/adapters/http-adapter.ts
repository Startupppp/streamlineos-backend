/**
 * HTTP adapter for the RBAC verification matrix.
 *
 * Wraps `createAuthzHarness` and translates matrix actor standings to harness
 * fixture states.  Each scenario is a pair: the negative case (deny) and the
 * positive control (allow).  The adapter runs both and returns the HTTP status
 * codes so the spec can assert them separately (BE-141).
 *
 * The harness runs the real `PermissionGuard` and `ModuleGuard` with mocked
 * services, so a request that passes the guard returns a visible non-403 answer
 * rather than exploding — which is what makes the positive control meaningful.
 */

import type { Type } from "@nestjs/common";
import request from "supertest";
import {
  createAuthzHarness,
  ORG_A,
  ORG_B,
  actorOf,
  type AuthzHarness,
} from "../../../helpers/authz-deny-harness";

export interface HttpScenarioConfig {
  readonly controllers: readonly Type<unknown>[];
  readonly verb: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly permissionKey: string;
  readonly extraProviders?: readonly unknown[];
}

export interface HttpAdapterResult {
  readonly denyStatus: number;
  readonly allowStatus: number;
}

/**
 * Runs the deny case (the actor holds every permission except `permissionKey`)
 * and the allow case (the actor holds all permissions) against the given route.
 */
export async function runHttpPermissionCell(
  config: HttpScenarioConfig,
): Promise<HttpAdapterResult> {
  const harness = await createAuthzHarness(config.controllers, {
    providers: config.extraProviders,
  });
  try {
    harness.denyOnly(config.permissionKey);
    const denyResp = await request(harness.server())
      [config.verb](config.path)
      .set("Content-Type", "application/json");

    harness.reset();
    harness.allowAll();
    const allowResp = await request(harness.server())
      [config.verb](config.path)
      .set("Content-Type", "application/json");

    return { denyStatus: denyResp.status, allowStatus: allowResp.status };
  } finally {
    await harness.close();
  }
}

/**
 * Runs the module-disabled case (402) and the module-enabled allow case.
 */
export async function runHttpModuleCell(
  config: HttpScenarioConfig,
  moduleDisabledReason: "org-disabled" | "not-in-plan" = "org-disabled",
): Promise<HttpAdapterResult> {
  const harness = await createAuthzHarness(config.controllers, {
    providers: config.extraProviders,
  });
  try {
    harness.allowAll();
    harness.disableModule(moduleDisabledReason);
    const denyResp = await request(harness.server())
      [config.verb](config.path)
      .set("Content-Type", "application/json");

    harness.reset();
    harness.allowAll();
    const allowResp = await request(harness.server())
      [config.verb](config.path)
      .set("Content-Type", "application/json");

    return { denyStatus: denyResp.status, allowStatus: allowResp.status };
  } finally {
    await harness.close();
  }
}

/**
 * Runs the cross-tenant case: the actor is from ORG_B requesting a resource
 * whose ownership check (inside the mocked service) will return 404.
 *
 * Because services are auto-mocked the 404 must come from the service itself —
 * this adapter is used with service-layer probes (job/file adapters) that
 * exercise the ownership check directly.  For HTTP-only scenarios where the
 * service is mocked to return nothing, the 404 is produced by the guard short-
 * circuiting on an empty result.
 */
export async function runHttpCrossTenantCell(
  config: HttpScenarioConfig,
): Promise<HttpAdapterResult> {
  const harness = await createAuthzHarness(config.controllers, {
    providers: config.extraProviders,
  });
  try {
    harness.allowAll();
    harness.actAs(actorOf({ orgId: ORG_B }));
    const crossTenantResp = await request(harness.server())
      [config.verb](config.path)
      .set("Content-Type", "application/json");

    harness.reset();
    harness.allowAll();
    harness.actAs(actorOf({ orgId: ORG_A }));
    const sameTenantResp = await request(harness.server())
      [config.verb](config.path)
      .set("Content-Type", "application/json");

    return { denyStatus: crossTenantResp.status, allowStatus: sameTenantResp.status };
  } finally {
    await harness.close();
  }
}

/** Convenience: open a harness, run `fn`, close it. */
export async function withHarness(
  controllers: readonly Type<unknown>[],
  fn: (h: AuthzHarness) => Promise<void>,
): Promise<void> {
  const harness = await createAuthzHarness(controllers);
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}
