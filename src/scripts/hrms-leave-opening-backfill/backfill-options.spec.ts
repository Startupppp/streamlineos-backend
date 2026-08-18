import { parseBackfillOptions } from "./backfill-options";

const hash = "a".repeat(64);
const keyId = `ed25519-sha256:${"b".repeat(64)}`;
const validArgs = [
  "--manifest=approval.json",
  `--manifest-sha256=${hash}`,
  "--signature=approval.sig",
  "--public-key=reviewers.pem",
  `--key-id=${keyId}`,
];

describe("leave opening backfill options", () => {
  it("defaults to a verified database-free dry run", () => {
    expect(parseBackfillOptions(validArgs)).toEqual({
      kind: "dry-run",
      options: {
        manifestPath: "approval.json",
        manifestSha256: hash,
        signaturePath: "approval.sig",
        publicKeyPath: "reviewers.pem",
        keyId,
      },
    });
  });

  it("makes apply deliberately unavailable", () => {
    expect(() => parseBackfillOptions(["--apply", ...validArgs])).toThrow(
      "LEAVE_OPENING_APPLY_UNAVAILABLE",
    );
  });

  it("requires every detached verification input", () => {
    expect(() => parseBackfillOptions(validArgs.slice(0, 4))).toThrow(
      "LEAVE_OPENING_VERIFICATION_INPUT_REQUIRED",
    );
  });

  it("rejects a key ID that is not an Ed25519 SPKI fingerprint", () => {
    expect(() =>
      parseBackfillOptions([
        ...validArgs.slice(0, 4),
        "--key-id=approval-key",
      ]),
    ).toThrow("LEAVE_OPENING_OPTIONS_INVALID");
  });

  it("supports help without verification material", () => {
    expect(parseBackfillOptions(["--help"])).toEqual({ kind: "help" });
  });
});
