import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { BackfillOptions } from "../modules/kb/retrieval/kb-page-backfill.service";

function readOption(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumber(args: string[], name: string, fallback?: number): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function parseOptions(args: string[]): BackfillOptions & { apply: boolean } {
  // Keep the original positional delay argument working for operators who
  // already run `backfill:kb-pages 250`.
  const positionalDelay = args.find((arg) => /^\d+(?:\.\d+)?$/.test(arg));
  return {
    apply: args.includes("--apply"),
    delayMs: readNumber(args, "--delay-ms", positionalDelay ? Number(positionalDelay) : undefined),
    batchSize: readNumber(args, "--batch-size"),
    afterPageId: readNumber(args, "--after-page-id"),
    maxPages: readNumber(args, "--max-pages"),
    orgId: readOption(args, "--org-id"),
  };
}

export function validateApplyOptions(
  options: BackfillOptions & { apply: boolean },
): string | undefined {
  if (!options.apply) return undefined;
  if (!options.orgId?.trim()) return "--org-id is required with --apply";
  if (!Number.isFinite(options.maxPages) || (options.maxPages ?? 0) <= 0)
    return "--max-pages must be a positive finite number with --apply";
  if (!Number.isFinite(options.batchSize) || (options.batchSize ?? 0) <= 0)
    return "--batch-size must be a positive finite number with --apply";
  if (!Number.isFinite(options.delayMs) || (options.delayMs ?? -1) < 0)
    return "--delay-ms must be a non-negative finite number with --apply";
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseOptions(args);

  const invalidApplyOptions = validateApplyOptions(options);
  if (invalidApplyOptions) {
    console.error(`Refusing to mutate KB indexes: ${invalidApplyOptions}. No data was changed.`);
    process.exitCode = 2;
    return;
  }

  if (!options.apply) {
    console.error(
      "Refusing to mutate KB indexes without --apply. Run report:kb-calendar-runtime first, then rerun this command with --apply and explicit bounds such as --org-id, --max-pages, --batch-size, and --delay-ms.",
    );
    process.exitCode = 2;
    return;
  }

  const { apply: _apply, ...backfillOptions } = options;

  // Keep the large application graph behind the explicit mutation guard. This
  // makes the default invocation fast, side-effect free, and usable as a
  // safety check even when runtime providers are unavailable.
  const [{ AppModule }, { KbPageBackfillService }] = await Promise.all([
    import("../app.module"),
    import("../modules/kb/retrieval/kb-page-backfill.service"),
  ]);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const backfill = app.get(KbPageBackfillService);
    const result = await backfill.backfillAll(backfillOptions);
    console.log(JSON.stringify(result, null, 2));
    if (result.totalFailed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
