import { validateEnv } from "../config/env.validation";

const SELF_TEST = process.argv.includes("--self-test");

if (SELF_TEST) {
  const savedEnv = { ...process.env };

  const missing = (key: string): void => {
    delete process.env[key];
  };

  missing("DATABASE_URL");
  missing("BACKEND_JWT_SECRET");
  missing("PORTAL_JWT_SECRET");
  missing("ENCRYPTION_KEY");
  missing("CORS_ORIGINS");
  missing("APP_URL");

  let threw = false;
  try {
    validateEnv(process.env as Record<string, unknown>);
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    const expectKeys = ["DATABASE_URL", "BACKEND_JWT_SECRET", "PORTAL_JWT_SECRET", "ENCRYPTION_KEY", "CORS_ORIGINS"];
    const allFound = expectKeys.every((k) => msg.includes(k));
    if (!allFound) {
      process.stderr.write(`SELF-TEST FAILED: error message missing expected keys.\n${msg}\n`);
      process.exit(1);
    }
  } finally {
    Object.assign(process.env, savedEnv);
  }

  if (!threw) {
    process.stderr.write("SELF-TEST FAILED: validateEnv did not throw on missing required variables.\n");
    process.exit(1);
  }

  process.stdout.write("SELF-TEST PASSED: validate-env correctly rejects a bare environment.\n");
  process.exit(0);
}

try {
  const config = validateEnv(process.env as Record<string, unknown>);
  process.stdout.write(`[validate-env] OK — NODE_ENV=${config.NODE_ENV}\n`);
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[validate-env] FAILED\n${msg}\n`);
  process.exit(1);
}
