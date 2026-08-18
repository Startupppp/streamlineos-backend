import { parseArgs } from "node:util";
import { z } from "zod";
import { fail } from "./backfill-error";

export type BackfillOptions = {
  manifestPath: string;
  manifestSha256: string;
  signaturePath: string;
  publicKeyPath: string;
  keyId: string;
};

export type ParsedBackfillCli =
  | { kind: "help" }
  | { kind: "dry-run"; options: BackfillOptions };

const pathSchema = z.string().trim().min(1).max(1024);
const hashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const keyIdSchema = z
  .string()
  .regex(/^ed25519-sha256:[a-f0-9]{64}$/);

export function parseBackfillOptions(args: string[]): ParsedBackfillCli {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: "boolean" },
        apply: { type: "boolean" },
        manifest: { type: "string" },
        "manifest-sha256": { type: "string" },
        signature: { type: "string" },
        "public-key": { type: "string" },
        "key-id": { type: "string" },
      },
    }));
  } catch {
    fail("LEAVE_OPENING_OPTIONS_INVALID");
  }
  if (values.help === true) return { kind: "help" };
  if (values.apply === true) fail("LEAVE_OPENING_APPLY_UNAVAILABLE");
  if (
    values.manifest === undefined ||
    values["manifest-sha256"] === undefined ||
    values.signature === undefined ||
    values["public-key"] === undefined ||
    values["key-id"] === undefined
  )
    fail("LEAVE_OPENING_VERIFICATION_INPUT_REQUIRED");

  const parsed = z
    .object({
      manifestPath: pathSchema,
      manifestSha256: hashSchema.transform((value) => value.toLowerCase()),
      signaturePath: pathSchema,
      publicKeyPath: pathSchema,
      keyId: keyIdSchema,
    })
    .safeParse({
      manifestPath: values.manifest,
      manifestSha256: values["manifest-sha256"],
      signaturePath: values.signature,
      publicKeyPath: values["public-key"],
      keyId: values["key-id"],
    });
  if (!parsed.success) fail("LEAVE_OPENING_OPTIONS_INVALID");
  return { kind: "dry-run", options: parsed.data };
}
