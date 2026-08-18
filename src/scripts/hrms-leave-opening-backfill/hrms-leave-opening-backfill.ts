import { safeFailureCode } from "./backfill-error";
import { loadAndVerifyLeaveOpeningManifest } from "./backfill-manifest";
import { parseBackfillOptions } from "./backfill-options";
import { buildLeaveOpeningDryRunReport } from "./backfill-plan";

const usage = `
HRMS legacy leave-opening backfill verifier

Dry-run verification only:
  node -r ts-node/register src/scripts/hrms-leave-opening-backfill/hrms-leave-opening-backfill.ts \\
    --manifest=<signed-id-only-manifest.json> \\
    --manifest-sha256=<raw-file-sha256> \\
    --signature=<detached-signature.base64> \\
    --public-key=<ed25519-public-key.pem> \\
    --key-id=ed25519-sha256:<public-spki-sha256>

The detached signature is standard base64 over the exact raw manifest bytes.
Database access and --apply are deliberately unavailable.
`;

async function main(): Promise<void> {
  const parsed = parseBackfillOptions(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(usage);
    return;
  }
  const verified = loadAndVerifyLeaveOpeningManifest(
    parsed.options,
    new Date(),
  );
  const report = buildLeaveOpeningDryRunReport(verified);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    code: safeFailureCode(error),
  })}\n`);
  process.exitCode = 1;
});
