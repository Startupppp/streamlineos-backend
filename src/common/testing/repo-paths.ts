import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const FRONTEND_MARKER = join("lib", "rbac", "permissions");
const FRONTEND_SIBLINGS = ["frontend", join("streamlineos-frontend", "frontend")];

function resolveRoot(
  marker: string,
  siblings: readonly string[],
  envName: string,
): string | null {
  const override = process.env[envName];
  if (override) {
    const abs = resolve(override);
    return existsSync(join(abs, marker)) ? abs : null;
  }
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    for (const name of siblings) {
      const candidate = resolve(dir, name);
      if (existsSync(join(candidate, marker))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function requireRoot(
  marker: string,
  siblings: readonly string[],
  envName: string,
  label: string,
): string {
  const root = resolveRoot(marker, siblings, envName);
  if (root === null)
    throw new Error(
      `${label} root not found. Searched for a directory containing "${marker}" beside or above ${__dirname}. ` +
        `Set ${envName} to override. This is a checkout-layout problem, not a drift finding — ` +
        `do not treat the missing file as evidence that the compared artifact was deleted.`,
    );
  return root;
}

export function frontendRoot(): string {
  return requireRoot(
    FRONTEND_MARKER,
    FRONTEND_SIBLINGS,
    "STREAMLINE_FRONTEND_ROOT",
    "Frontend",
  );
}

export function frontendPath(...segments: string[]): string {
  return join(frontendRoot(), ...segments);
}
