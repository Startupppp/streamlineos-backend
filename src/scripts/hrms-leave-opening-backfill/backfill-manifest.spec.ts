import { generateKeyPairSync } from "node:crypto";
import {
  deriveEd25519Key,
  verifyLeaveOpeningManifest,
} from "./backfill-manifest";
import {
  createBackfillTestFixture,
  encodeSignedManifest,
  fixtureNow,
} from "./backfill-test-fixture";

describe("leave opening signed manifest", () => {
  it("verifies the raw hash, manifest-bound key, and detached signature", () => {
    const fixture = createBackfillTestFixture();
    const verified = verifyLeaveOpeningManifest(
      fixture.rawManifest,
      fixture.manifestSha256,
      fixture.signature,
      fixture.publicKeyPem,
      fixture.keyId,
      fixtureNow,
    );
    expect(verified.manifest.entries).toHaveLength(5);
    expect(verified.manifest.source).toEqual({
      rowCount: 5,
      totalBalance: "94.2000",
    });
  });

  it("rejects a raw manifest hash mismatch", () => {
    const fixture = createBackfillTestFixture();
    expect(() =>
      verifyLeaveOpeningManifest(
        fixture.rawManifest,
        "0".repeat(64),
        fixture.signature,
        fixture.publicKeyPem,
        fixture.keyId,
        fixtureNow,
      ),
    ).toThrow("LEAVE_OPENING_MANIFEST_HASH_MISMATCH");
  });

  it("rejects a detached signature mismatch", () => {
    const fixture = createBackfillTestFixture();
    expect(() =>
      verifyLeaveOpeningManifest(
        fixture.rawManifest,
        fixture.manifestSha256,
        Buffer.alloc(64).toString("base64"),
        fixture.publicKeyPem,
        fixture.keyId,
        fixtureNow,
      ),
    ).toThrow("LEAVE_OPENING_SIGNATURE_MISMATCH");
  });

  it("binds the manifest and expected ID to the public key fingerprint", () => {
    const fixture = createBackfillTestFixture();
    const other = generateKeyPairSync("ed25519").publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const otherKeyId = deriveEd25519Key(other).keyId;
    expect(() =>
      verifyLeaveOpeningManifest(
        fixture.rawManifest,
        fixture.manifestSha256,
        fixture.signature,
        other,
        otherKeyId,
        fixtureNow,
      ),
    ).toThrow("LEAVE_OPENING_KEY_ID_MISMATCH");
  });

  it("rejects non-Ed25519 public keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    expect(() => deriveEd25519Key(rsa)).toThrow(
      "LEAVE_OPENING_PUBLIC_KEY_NOT_ED25519",
    );
  });

  it("rejects expired approval", () => {
    const fixture = createBackfillTestFixture();
    expect(() =>
      verifyLeaveOpeningManifest(
        fixture.rawManifest,
        fixture.manifestSha256,
        fixture.signature,
        fixture.publicKeyPem,
        fixture.keyId,
        new Date("2026-08-12T00:00:00.000Z"),
      ),
    ).toThrow("LEAVE_OPENING_MANIFEST_EXPIRED");
  });

  it("rejects PII-shaped unknown fields", () => {
    const fixture = createBackfillTestFixture();
    const value = {
      ...fixture.manifest,
      reviewerEmail: "forbidden@example.invalid",
    };
    const signed = encodeSignedManifest(value, fixture.privateKey);
    expect(() =>
      verifyLeaveOpeningManifest(
        signed.rawManifest,
        signed.manifestSha256,
        signed.signature,
        fixture.publicKeyPem,
        fixture.keyId,
        fixtureNow,
      ),
    ).toThrow("LEAVE_OPENING_MANIFEST_INVALID");
  });

  it("requires two distinct reviewer IDs and roles", () => {
    const fixture = createBackfillTestFixture();
    const value = {
      ...fixture.manifest,
      reviewers: [
        { reviewerId: "same-reviewer", role: "ORG_DATA_OWNER" },
        { reviewerId: "same-reviewer", role: "ORG_DATA_OWNER" },
      ],
    };
    const signed = encodeSignedManifest(value, fixture.privateKey);
    expect(() =>
      verifyLeaveOpeningManifest(
        signed.rawManifest,
        signed.manifestSha256,
        signed.signature,
        fixture.publicKeyPem,
        fixture.keyId,
        fixtureNow,
      ),
    ).toThrow("LEAVE_OPENING_MANIFEST_INVALID");
  });

  it("rejects entry totals that do not match 94.2000", () => {
    const fixture = createBackfillTestFixture();
    const entries = fixture.manifest.entries.map((entry, index) =>
      index === 0 ? { ...entry, sourceBalance: "10.1000" } : entry,
    );
    const signed = encodeSignedManifest(
      { ...fixture.manifest, entries },
      fixture.privateKey,
    );
    expect(() =>
      verifyLeaveOpeningManifest(
        signed.rawManifest,
        signed.manifestSha256,
        signed.signature,
        fixture.publicKeyPem,
        fixture.keyId,
        fixtureNow,
      ),
    ).toThrow("LEAVE_OPENING_MANIFEST_INVALID");
  });

  it("rejects duplicate source balance IDs", () => {
    const fixture = createBackfillTestFixture();
    const entries = fixture.manifest.entries.map((entry, index) =>
      index === 1 ? { ...entry, sourceBalanceId: 1 } : entry,
    );
    const signed = encodeSignedManifest(
      { ...fixture.manifest, entries },
      fixture.privateKey,
    );
    expect(() =>
      verifyLeaveOpeningManifest(
        signed.rawManifest,
        signed.manifestSha256,
        signed.signature,
        fixture.publicKeyPem,
        fixture.keyId,
        fixtureNow,
      ),
    ).toThrow("LEAVE_OPENING_MANIFEST_INVALID");
  });
});
