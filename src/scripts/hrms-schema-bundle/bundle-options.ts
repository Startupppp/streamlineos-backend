import { parseArgs } from "node:util";
import { z } from "zod";
import {
  bundleFileNameSchema,
  type BundleFileName,
} from "./bundle-config";
import { fail } from "./bundle-error";

export type BundleOptions = {
  apply: boolean;
  rollback: boolean;
  rollbackThrough: BundleFileName | null;
  manifestPath: string | null;
  manifestSha256: string | null;
  acknowledgeProduction: boolean;
};

export type ParsedBundleCli =
  | { kind: "help" }
  | { kind: "run"; options: BundleOptions };

const pathSchema = z.string().trim().min(1).max(1024);
const suppliedHashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);

export function parseBundleOptions(args: string[]): ParsedBundleCli {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: "boolean" },
        apply: { type: "boolean" },
        rollback: { type: "boolean" },
        "rollback-through": { type: "string" },
        manifest: { type: "string" },
        "manifest-sha256": { type: "string" },
        "ack-production": { type: "boolean" },
      },
    }));
  } catch {
    fail("RUNNER_OPTIONS_INVALID");
  }
  if (values.help === true) return { kind: "help" };

  const manifestPath = values.manifest
    ? pathSchema.parse(values.manifest)
    : null;
  const manifestSha256 = values["manifest-sha256"]
    ? suppliedHashSchema.parse(values["manifest-sha256"]).toLowerCase()
    : null;
  const apply = values.apply === true;
  const rollback = values.rollback === true;
  const rollbackThrough = values["rollback-through"]
    ? bundleFileNameSchema.parse(values["rollback-through"])
    : null;
  const acknowledgeProduction = values["ack-production"] === true;

  if ((manifestPath === null) !== (manifestSha256 === null))
    fail("RUNNER_MANIFEST_PAIR_REQUIRED");
  if (apply && rollback) fail("RUNNER_ACTION_CONFLICT");
  if ((rollbackThrough === null) !== !rollback)
    fail("RUNNER_ROLLBACK_SCOPE_REQUIRED");
  if (apply && manifestPath === null) fail("RUNNER_APPLY_MANIFEST_REQUIRED");
  if (rollback && manifestPath === null)
    fail("RUNNER_ROLLBACK_MANIFEST_REQUIRED");
  if (!apply && !rollback && acknowledgeProduction)
    fail("RUNNER_ACK_WITHOUT_APPLY");

  return {
    kind: "run",
    options: {
      apply,
      rollback,
      rollbackThrough,
      manifestPath,
      manifestSha256,
      acknowledgeProduction,
    },
  };
}
