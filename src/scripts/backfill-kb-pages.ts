import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import {
  KbPageBackfillService,
  type BackfillOptions,
} from "../modules/kb/retrieval/kb-page-backfill.service";

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

function parseOptions(args: string[]): BackfillOptions {
  // Keep the original positional delay argument working for operators who
  // already run `backfill:kb-pages 250`.
  const positionalDelay = args.find((arg) => /^\d+(?:\.\d+)?$/.test(arg));
  return {
    delayMs: readNumber(args, "--delay-ms", positionalDelay ? Number(positionalDelay) : undefined),
    batchSize: readNumber(args, "--batch-size"),
    afterPageId: readNumber(args, "--after-page-id"),
    maxPages: readNumber(args, "--max-pages"),
    orgId: readOption(args, "--org-id"),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const backfill = app.get(KbPageBackfillService);
    const result = await backfill.backfillAll(options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
