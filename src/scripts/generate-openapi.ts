import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { buildOpenApiDocument } from "../common/openapi/build-openapi-document";
import { applyOpenApiEnv } from "./openapi-env";

export const OPENAPI_ARTIFACT_PATH = resolve(__dirname, "..", "..", "openapi.json");

export async function generateOpenApiJson(): Promise<{
  json: string;
  stamped: number;
  undeclared: number;
  contractsApplied: number;
  unconvertible: string[];
  operations: number;
  pageSizeCapsApplied: number;
}> {
  applyOpenApiEnv();
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });

  try {
    const built = buildOpenApiDocument(app);
    let operations = 0;
    for (const pathItem of Object.values(built.document.paths)) {
      if (typeof pathItem === "object" && pathItem !== null)
        operations += Object.keys(pathItem).length;
    }
    return {
      json: `${JSON.stringify(built.document, null, 2)}\n`,
      stamped: built.stamped,
      undeclared: built.undeclared,
      contractsApplied: built.contractsApplied,
      unconvertible: built.unconvertible,
      operations,
      pageSizeCapsApplied: built.pageSizeCapsApplied,
    };
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const result = await generateOpenApiJson();
  writeFileSync(OPENAPI_ARTIFACT_PATH, result.json, "utf8");
  process.stdout.write(
    [
      `openapi.json written — ${String(result.operations)} operations`,
      `exposure stamped on ${String(result.stamped)}, ${String(result.undeclared)} undeclared`,
      `zod contracts applied to ${String(result.contractsApplied)} operations`,
      `page-size caps applied to ${String(result.pageSizeCapsApplied)} parameters`,
      result.unconvertible.length > 0
        ? `unconvertible zod schemas: ${String(result.unconvertible.length)}`
        : "every zod schema converted",
    ].join("\n") + "\n",
  );
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(
        `openapi generation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
