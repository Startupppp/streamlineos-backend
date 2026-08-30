/**
 * Validates and applies the minimum environment required for OpenAPI contract
 * generation before NestFactory.create is called.
 *
 * Call this at the top of every script that boots the Nest application solely
 * to produce the contract (generate-openapi.ts, check-openapi-fresh.ts).
 * It gives a named error that lists every missing variable before the
 * application itself has a chance to produce an opaque DI or RegionModule
 * error.
 *
 * See architecture-refactor/final-refactor/evidence/41-openapi/OPENAPI-CI.md
 * for the reasoning behind each variable and why placeholder values are safe.
 */

interface RequiredVar {
  readonly name: string;
  readonly minLen: number;
}

const MINIMUM_VARS: readonly RequiredVar[] = [
  { name: "DATABASE_URL", minLen: 1 },
  { name: "BACKEND_JWT_SECRET", minLen: 44 },
  { name: "PORTAL_JWT_SECRET", minLen: 44 },
  { name: "CORS_ORIGINS", minLen: 1 },
  { name: "APP_URL", minLen: 1 },
  { name: "ENCRYPTION_KEY", minLen: 32 },
];

export class OpenApiEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `[openapi-env] Contract generation requires the following variables to be set:\n` +
        missing.map((name) => `  ${name}`).join("\n") +
        `\n\nSee architecture-refactor/final-refactor/evidence/41-openapi/OPENAPI-CI.md` +
        ` for the minimum values and the reason each variable is required.`,
    );
    this.name = "OpenApiEnvError";
    this.missing = missing;
  }
}

/**
 * Applies the non-production topology seam for contract generation.
 *
 * Side effects:
 *   - Forces NODE_ENV to "test" when the caller did not set a non-production
 *     value. "test" is required because NODE_ENV="production" activates extra
 *     required variables (CRON_SECRET, etc.) in validateEnv() and makes the
 *     RLS lifecycle check throw instead of log, which would surface as a DI
 *     boot error rather than a readable environment error.
 *   - Throws OpenApiEnvError synchronously if any of the six minimum variables
 *     are absent or too short, before NestFactory.create is reached.
 */
export function applyOpenApiEnv(): void {
  if (!process.env.NODE_ENV || process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }

  const missing: string[] = [];
  for (const { name, minLen } of MINIMUM_VARS) {
    const value = process.env[name];
    if (!value || value.length < minLen) missing.push(name);
  }

  if (missing.length > 0) throw new OpenApiEnvError(missing);
}
