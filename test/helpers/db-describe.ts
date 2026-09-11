const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;

type SuiteFactory = (name: string, fn: () => void) => void;

function loudSkip(name: string, fn: () => void): void {
  process.stderr.write(
    `\nSKIPPED (no DB): "${name}" — set RBAC_E2E_DATABASE_URL to run this suite\n`,
  );
  describe.skip(name, fn);
}

export const describeWithDb: SuiteFactory = RBAC_E2E_DATABASE_URL ? describe : loudSkip;

// For a suite that overrides DRIZZLE with a mock: it opens no connection, so gating it on a database URL only hides it.
export const describeWithMockedDb: SuiteFactory = describe;

export { RBAC_E2E_DATABASE_URL };
