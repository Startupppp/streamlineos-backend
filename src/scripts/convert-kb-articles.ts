import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ArchitectureEvidenceModule } from "./architecture-evidence.module";
import { KbArticleMigrationService } from "../modules/kb/article-conversion/kb-article-migration.service";

const CONFIRMATION = "CONVERT_PUBLISHED_ARTICLES";

function option(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export interface ConversionCliOptions {
  apply: boolean;
  orgId?: string;
  userId?: string;
  confirmation?: string;
}

export function parseConversionOptions(args: string[]): ConversionCliOptions {
  return {
    apply: args.includes("--apply"),
    orgId: option(args, "--org-id"),
    userId: option(args, "--user-id"),
    confirmation: option(args, "--confirmation"),
  };
}

async function main(): Promise<void> {
  const options = parseConversionOptions(process.argv.slice(2));
  if (
    options.apply &&
    (!options.orgId || !options.userId || options.confirmation !== CONFIRMATION)
  ) {
    console.error(
      `A mutating conversion requires --apply, --org-id, --user-id and --confirmation=${CONFIRMATION}. No data was changed.`,
    );
    process.exitCode = 2;
    return;
  }

  const app = await NestFactory.createApplicationContext(ArchitectureEvidenceModule, {
    logger: false,
  });

  try {
    const conversion = app.get(KbArticleMigrationService);
    if (!options.apply) {
      const report = options.orgId
        ? await conversion.preview(options.orgId)
        : await conversion.reportAll();
      console.log(JSON.stringify({ mode: "preview", readOnly: true, report }, null, 2));
      return;
    }

    const result = await conversion.run(
      {
        orgId: options.orgId!,
        userId: options.userId!,
      } as never,
      { dryRun: false, confirmation: CONFIRMATION },
    );
    console.log(JSON.stringify({ mode: "apply", orgId: options.orgId, result }, null, 2));
    if (result.failed > 0) process.exitCode = 1;
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
