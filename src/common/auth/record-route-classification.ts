import { PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { AUTHORIZED_IN_SERVICE } from "./authorized-in-service.decorator";
import { IS_PUBLIC } from "./public.decorator";
import { IS_UNIVERSAL } from "./universal.decorator";
import { REQUIRE_PERMISSION } from "../rbac/require-permission-key";
import { DEPRECATION_KEY, type DeprecationMeta } from "../deprecation/deprecated.decorator";

export type RouteExposure =
  | { mode: "public" }
  | { mode: "universal" }
  | { mode: "permissioned"; permission: string }
  | { mode: "in-service"; by: string }
  | { mode: "undeclared" };

// Extensions are `unknown` in Nest's own types, so a mutable view is the honest shape.
interface StampableOperation {
  operationId?: string;
  description?: string;
  [key: string]: unknown;
}

function stampable(value: unknown): value is StampableOperation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "operationId") === "string"
  );
}

function read(key: string, handler: object, classRef: object): unknown {
  const own: unknown = Reflect.getMetadata(key, handler);
  return own === undefined ? Reflect.getMetadata(key, classRef) : own;
}

function readString(key: string, handler: object, classRef: object): string | undefined {
  const value = read(key, handler, classRef);
  return typeof value === "string" ? value : undefined;
}

export function classifyHandler(handler: object, classRef: object): RouteExposure {
  if (read(IS_PUBLIC, handler, classRef) === true) return { mode: "public" };
  if (read(IS_UNIVERSAL, handler, classRef) === true) return { mode: "universal" };
  const by = readString(AUTHORIZED_IN_SERVICE, handler, classRef);
  if (by !== undefined && by !== "") return { mode: "in-service", by };
  const permission = readString(REQUIRE_PERMISSION, handler, classRef);
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

// URI versioning appends "_<version>" to operationId (e.g. "ClassName_method_1").
// Strip it so the lookup matches the map key "ClassName_method" regardless of which
// versioned copy of the route the document contains.
/**
 * Nest suffixes an operationId twice over, and both have to come off to reach the
 * method name this map is keyed by: `_1`, `_2`… when two handlers would collide, and
 * `_v2`, `_v3`… for every route carrying `@Version`.
 *
 * Only the numeric form was stripped, so a versioned operation never matched and was
 * silently skipped — `GET /v2/users` and `GET /v2/users/{userId}` both carry
 * `@RequirePermission("settings:view")` and both shipped with no `x-exposure`. The
 * stamping loop counted them as neither stamped nor undeclared, so the generator
 * reported "0 undeclared" over two operations it had not classified at all.
 */
export function normalizeOperationId(id: string): string {
  return id.replace(/_v\d+$/, "").replace(/_\d+$/, "");
}

interface OperationMeta {
  exposure: RouteExposure;
  deprecation?: DeprecationMeta;
}

// Read from the same four metadata keys the guard reads, so the document cannot drift.
export function recordRouteClassification(
  app: INestApplication,
  document: { paths?: unknown },
): { stamped: number; undeclared: number } {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);

  const byOperationId = new Map<string, OperationMeta>();
  for (const wrapper of discovery.getControllers()) {
    const { instance } = wrapper;
    if (!instance || typeof instance !== "object") continue;
    const proto: object = Object.getPrototypeOf(instance);
    const classRef = proto.constructor;

    for (const methodName of scanner.getAllMethodNames(proto)) {
      const handler: unknown = Reflect.get(proto, methodName);
      if (typeof handler !== "function") continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      const depMeta: unknown = read(DEPRECATION_KEY, handler, classRef);
      byOperationId.set(`${classRef.name}_${methodName}`, {
        exposure: classifyHandler(handler, classRef),
        deprecation: typeof depMeta === "object" && depMeta !== null
          ? (depMeta as DeprecationMeta)
          : undefined,
      });
    }
  }

  let stamped = 0;
  let undeclared = 0;
  const paths: unknown = document.paths;
  if (typeof paths !== "object" || paths === null) return { stamped, undeclared };

  for (const pathItem of Object.values(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const operation of Object.values(pathItem)) {
      if (!stampable(operation)) continue;
      const meta = byOperationId.get(normalizeOperationId(String(operation.operationId)));
      if (!meta) {
        // Counted, not skipped. A silent `continue` here is what let two versioned
        // operations ship unstamped while the generator reported "0 undeclared":
        // an operation whose handler cannot be found is exactly as unclassified as
        // one that declares nothing, and the caller's freshness check reads this
        // number to decide whether stamping covered the document.
        undeclared += 1;
        continue;
      }

      const { exposure, deprecation } = meta;
      const summary = describeExposure(exposure);
      operation["x-exposure"] = exposure.mode;
      if (exposure.mode === "permissioned") operation["x-permission"] = exposure.permission;
      if (exposure.mode === "in-service") operation["x-authorized-in-service"] = exposure.by;
      operation.description = operation.description
        ? `${operation.description}\n\nExposure: ${summary}`
        : `Exposure: ${summary}`;
      if (deprecation !== undefined) {
        operation["deprecated"] = true;
        if (deprecation.sunset) operation["x-sunset"] = deprecation.sunset;
        if (deprecation.link) operation["x-deprecation-link"] = deprecation.link;
      }
      stamped++;
      if (exposure.mode === "undeclared") undeclared++;
    }
  }

  return { stamped, undeclared };
}
