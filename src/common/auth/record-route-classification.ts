import { PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AUTHORIZED_IN_SERVICE } from "./authorized-in-service.decorator";
import { IS_PUBLIC } from "./public.decorator";
import { IS_UNIVERSAL } from "./universal.decorator";
import { REQUIRE_PERMISSION } from "../../modules/access/require-permission.decorator";

export type RouteExposure =
  | { mode: "public" }
  | { mode: "universal" }
  | { mode: "permissioned"; permission: string }
  | { mode: "in-service"; by: string }
  | { mode: "undeclared" };

interface OpenApiOperation {
  operationId?: string;
  description?: string;
  [key: string]: unknown;
}

type OpenApiDocument = {
  paths?: Record<string, Record<string, unknown>>;
};

const read = <T>(key: string, handler: object, classRef: object): T | undefined => {
  const own = Reflect.getMetadata(key, handler) as T | undefined;
  return own === undefined ? (Reflect.getMetadata(key, classRef) as T | undefined) : own;
};

export function classifyHandler(handler: object, classRef: object): RouteExposure {
  if (read<boolean>(IS_PUBLIC, handler, classRef)) return { mode: "public" };
  if (read<boolean>(IS_UNIVERSAL, handler, classRef)) return { mode: "universal" };
  const by = read<string>(AUTHORIZED_IN_SERVICE, handler, classRef);
  if (by !== undefined && by !== "") return { mode: "in-service", by };
  const permission = read<string>(REQUIRE_PERMISSION, handler, classRef);
  if (permission !== undefined) return { mode: "permissioned", permission };
  return { mode: "undeclared" };
}

export function describeExposure(exposure: RouteExposure): string {
  switch (exposure.mode) {
    case "public":
      return "public — unauthenticated";
    case "universal":
      return "universal — any authenticated member, subject from the token";
    case "permissioned":
      return `permission — ${exposure.permission}`;
    case "in-service":
      return `authorized in service — ${exposure.by}`;
    case "undeclared":
      return "UNDECLARED — no exposure declaration";
  }
}

/**
 * Stamps every operation with the exposure its handler declares, reading the
 * same four metadata keys RouteClassifierGuard reads.
 *
 * Derived from metadata rather than from a new per-operation decorator, so it
 * cannot drift from the guard and costs nothing across 3,500 handlers. Called
 * only inside main.ts's `isDevelopment` block, so no document is served in
 * production regardless.
 */
export function recordRouteClassification(
  app: INestApplication,
  document: OpenApiDocument,
): { stamped: number; undeclared: number } {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);

  const byOperationId = new Map<string, RouteExposure>();
  for (const wrapper of discovery.getControllers()) {
    const { instance } = wrapper;
    if (!instance || typeof instance !== "object") continue;
    const proto: object = Object.getPrototypeOf(instance);
    const classRef: object = proto.constructor;

    for (const methodName of scanner.getAllMethodNames(proto)) {
      const handler: unknown = Reflect.get(proto, methodName);
      if (typeof handler !== "function") continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      byOperationId.set(
        `${(classRef as { name: string }).name}_${methodName}`,
        classifyHandler(handler, classRef),
      );
    }
  }

  let stamped = 0;
  let undeclared = 0;
  for (const methods of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(methods)) {
      if (typeof operation !== "object" || operation === null) continue;
      const op = operation as OpenApiOperation;
      if (typeof op.operationId !== "string") continue;
      const exposure = byOperationId.get(op.operationId);
      if (!exposure) continue;

      const summary = describeExposure(exposure);
      op["x-exposure"] = exposure.mode;
      if (exposure.mode === "permissioned") op["x-permission"] = exposure.permission;
      if (exposure.mode === "in-service") op["x-authorized-in-service"] = exposure.by;
      op.description = op.description ? `${op.description}\n\nExposure: ${summary}` : `Exposure: ${summary}`;
      stamped++;
      if (exposure.mode === "undeclared") undeclared++;
    }
  }

  return { stamped, undeclared };
}
