import type { OrganizationPlacement } from "./placement";
import {
  resolvePlacementKeyring,
  signPlacement,
  verifyPlacement,
  type PlacementKeyring,
} from "./placement-signature";

const NOW = 1_000_000;
const EXPIRES = NOW + 60_000;

const keyring: PlacementKeyring = {
  current: { keyId: "cp-1", secret: "a".repeat(44) },
  previous: [{ keyId: "cp-0", secret: "b".repeat(44) }],
};

const placement: OrganizationPlacement = {
  organizationId: "org-1",
  region: "eu",
  cellId: "legacy-1",
  databaseShard: "primary",
  objectStorageRegion: "eu",
  searchCluster: "primary",
  placementVersion: 7,
  writeFenceToken: "fence-a",
  leaseExpiresAt: NOW + 3_600_000,
  status: "ACTIVE",
};

describe("a signed placement", () => {
  it("round-trips every field the router needs", () => {
    const verdict = verifyPlacement(
      signPlacement(placement, EXPIRES, keyring.current),
      keyring,
      NOW,
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.placement).toEqual(placement);
  });

  it("is rejected once its expiry has passed, rather than renewed locally", () => {
    const token = signPlacement(placement, EXPIRES, keyring.current);
    const verdict = verifyPlacement(token, keyring, EXPIRES + 1);
    expect(verdict).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("is rejected exactly at its expiry, not one tick later", () => {
    const token = signPlacement(placement, EXPIRES, keyring.current);
    expect(verifyPlacement(token, keyring, EXPIRES)).toEqual({
      ok: false,
      reason: "EXPIRED",
    });
  });

  it("is rejected when the placement version in the body is edited", () => {
    const token = signPlacement(placement, EXPIRES, keyring.current);
    const parts = token.split(".");
    const body = JSON.parse(
      Buffer.from(parts[2] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    body["v"] = 8;
    parts[2] = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");

    expect(verifyPlacement(parts.join("."), keyring, NOW)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("is rejected when the cell is edited, which is the cross-cell forgery", () => {
    const token = signPlacement(placement, EXPIRES, keyring.current);
    const parts = token.split(".");
    const body = JSON.parse(
      Buffer.from(parts[2] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    body["c"] = "cell-b";
    parts[2] = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");

    expect(verifyPlacement(parts.join("."), keyring, NOW)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("is rejected when an absent fence is swapped for an empty-string fence", () => {
    const unfenced: OrganizationPlacement = {
      ...placement,
      writeFenceToken: null,
      leaseExpiresAt: null,
    };
    const token = signPlacement(unfenced, EXPIRES, keyring.current);
    const parts = token.split(".");
    const body = JSON.parse(
      Buffer.from(parts[2] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    body["f"] = "";
    parts[2] = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");

    expect(verifyPlacement(parts.join("."), keyring, NOW)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("distinguishes an absent lease from a zero lease", () => {
    const absent = signPlacement(
      { ...placement, leaseExpiresAt: null },
      EXPIRES,
      keyring.current,
    );
    const zero = signPlacement(
      { ...placement, leaseExpiresAt: 0 },
      EXPIRES,
      keyring.current,
    );

    expect(absent).not.toEqual(zero);
  });

  it("is rejected when signed by a key this deployment does not know", () => {
    const foreign = { keyId: "cp-9", secret: "c".repeat(44) };
    const token = signPlacement(placement, EXPIRES, foreign);
    expect(verifyPlacement(token, keyring, NOW)).toEqual({
      ok: false,
      reason: "UNKNOWN_KEY",
    });
  });

  it("still accepts a token signed by the previous key, so rotation is not a flag day", () => {
    const previous = keyring.previous[0];
    if (!previous) throw new Error("fixture requires a previous key");
    const verdict = verifyPlacement(
      signPlacement(placement, EXPIRES, previous),
      keyring,
      NOW,
    );
    expect(verdict.ok).toBe(true);
  });

  it("rejects a token whose key id was swapped to one this deployment does hold", () => {
    const previous = keyring.previous[0];
    if (!previous) throw new Error("fixture requires a previous key");
    const token = signPlacement(placement, EXPIRES, previous);
    const parts = token.split(".");
    parts[1] = "cp-1";

    const verdict = verifyPlacement(parts.join("."), keyring, NOW);
    expect(verdict.ok).toBe(false);
  });

  it("rejects a malformed token instead of throwing", () => {
    for (const bad of ["", "nonsense", "pl1.cp-1.body", "xx.cp-1.body.sig"])
      expect(verifyPlacement(bad, keyring, NOW).ok).toBe(false);
  });

  it("survives a placement with no fence, which is the unit-test shape", () => {
    const unfenced: OrganizationPlacement = {
      ...placement,
      writeFenceToken: null,
      leaseExpiresAt: null,
    };
    const verdict = verifyPlacement(
      signPlacement(unfenced, EXPIRES, keyring.current),
      keyring,
      NOW,
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.placement.writeFenceToken).toBeNull();
  });
});

describe("the keyring read from the environment", () => {
  it("falls back to the backend JWT secret so an existing deployment needs no new variable", () => {
    const resolved = resolvePlacementKeyring({ BACKEND_JWT_SECRET: "x".repeat(44) });
    expect(resolved?.current.secret).toBe("x".repeat(44));
    expect(resolved?.current.keyId).toBe("cp-1");
  });

  it("prefers the dedicated key when one is set", () => {
    const resolved = resolvePlacementKeyring({
      BACKEND_JWT_SECRET: "x".repeat(44),
      PLACEMENT_SIGNING_KEY: "y".repeat(44),
      PLACEMENT_SIGNING_KEY_ID: "cp-7",
    });
    expect(resolved?.current).toEqual({ keyId: "cp-7", secret: "y".repeat(44) });
  });

  it("is null when nothing is configured, so the module refuses to boot rather than signing with a default", () => {
    expect(resolvePlacementKeyring({})).toBeNull();
  });
});
