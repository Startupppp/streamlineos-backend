const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;

type SuiteFactory = (name: string, fn: () => void) => void;

function loudSkip(name: string, fn: () => void): void {
  process.stderr.write(
    `\nSKIPPED (no DB): "${name}" — set RBAC_E2E_DATABASE_URL to run this suite\n`,
  );
  describe.skip(name, fn);
}

export const describeWithDb: SuiteFactory = RBAC_E2E_DATABASE_URL ? describe : loudSkip;

export { RBAC_E2E_DATABASE_URL };
