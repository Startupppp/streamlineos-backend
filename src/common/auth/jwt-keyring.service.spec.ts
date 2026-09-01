import { Test } from "@nestjs/testing";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";
import { JwtKeyringService } from "./jwt-keyring.service";
import { INTERNAL_TOKEN_AUDIENCE, INTERNAL_TOKEN_ISSUER } from "./backend-claims";

async function buildTestKeys(): Promise<string> {
  const kp = generateKeyPairSync("ed25519");
  const privateJwk = await exportJWK(kp.privateKey as unknown as CryptoKey);
  const publicJwk = await exportJWK(kp.publicKey as unknown as CryptoKey);
  return JSON.stringify([{ kid: "test-key-1", privateKey: privateJwk, publicKey: publicJwk }]);
}

async function buildTestKeysTwo(): Promise<{ keys: string; kid1: string; kid2: string }> {
  const kp1 = generateKeyPairSync("ed25519");
  const kp2 = generateKeyPairSync("ed25519");
  const priv1 = await exportJWK(kp1.privateKey as unknown as CryptoKey);
  const pub1 = await exportJWK(kp1.publicKey as unknown as CryptoKey);
  const priv2 = await exportJWK(kp2.privateKey as unknown as CryptoKey);
  const pub2 = await exportJWK(kp2.publicKey as unknown as CryptoKey);
  return {
    keys: JSON.stringify([
      { kid: "key-old", privateKey: priv1, publicKey: pub1 },
      { kid: "key-new", privateKey: priv2, publicKey: pub2 },
    ]),
    kid1: "key-old",
    kid2: "key-new",
  };
}

describe("JwtKeyringService", () => {
  let service: JwtKeyringService;
  const original = process.env.AUTH_SIGNING_KEYS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AUTH_SIGNING_KEYS;
    } else {
      process.env.AUTH_SIGNING_KEYS = original;
    }
  });

  async function makeService(keysJson: string): Promise<JwtKeyringService> {
    process.env.AUTH_SIGNING_KEYS = keysJson;
    const module = await Test.createTestingModule({
      providers: [JwtKeyringService],
    }).compile();
    const svc = module.get(JwtKeyringService);
    await svc.onModuleInit();
    return svc;
  }

  it("loads keys and reports isReady()", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);
    expect(service.isReady()).toBe(true);
  });

  it("is not ready when AUTH_SIGNING_KEYS is absent", async () => {
    delete process.env.AUTH_SIGNING_KEYS;
    const module = await Test.createTestingModule({ providers: [JwtKeyringService] }).compile();
    const svc = module.get(JwtKeyringService);
    await svc.onModuleInit();
    expect(svc.isReady()).toBe(false);
  });

  it("sign+verify roundtrip returns correct claims", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const token = await service.signToken({ sub: "user-1", orgId: "org-1", sessionId: "sess-1" });
    const claims = await service.verifyToken(token);

    expect(claims?.sub).toBe("user-1");
    expect(claims?.orgId).toBe("org-1");
    expect(claims?.sessionId).toBe("sess-1");
  });

  it("verifyToken returns null for a token with wrong issuer", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const { SignJWT } = await import("jose");
    const { importJWK } = await import("jose");
    const entries = JSON.parse(keysJson) as Array<{ kid: string; privateKey: JsonWebKey; publicKey: JsonWebKey }>;
    const privateKey = await importJWK(entries[0].privateKey, "EdDSA");
    const badIssuerToken = await new SignJWT({ orgId: "org-1", sessionId: "sess-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: entries[0].kid })
      .setSubject("user-1")
      .setIssuer("evil-issuer")
      .setAudience(INTERNAL_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);

    const claims = await service.verifyToken(badIssuerToken);
    expect(claims).toBeNull();
  });

  it("verifyToken returns null for a token with wrong audience", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const { SignJWT, importJWK } = await import("jose");
    const entries = JSON.parse(keysJson) as Array<{ kid: string; privateKey: JsonWebKey; publicKey: JsonWebKey }>;
    const privateKey = await importJWK(entries[0].privateKey, "EdDSA");
    const badAudienceToken = await new SignJWT({ orgId: "org-1", sessionId: "sess-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: entries[0].kid })
      .setSubject("user-1")
      .setIssuer(INTERNAL_TOKEN_ISSUER)
      .setAudience("wrong-audience")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);

    const claims = await service.verifyToken(badAudienceToken);
    expect(claims).toBeNull();
  });

  it("verifyToken returns null for a token signed by an unregistered key", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const { generateKeyPairSync: gen } = await import("node:crypto");
    const { SignJWT, exportJWK: expJwk, importJWK } = await import("jose");
    const foreign = gen("ed25519");
    const foreignPrivJwk = await expJwk(foreign.privateKey as unknown as CryptoKey);
    const foreignPriv = await importJWK(foreignPrivJwk, "EdDSA");

    const badKeyToken = await new SignJWT({ orgId: "org-1", sessionId: "sess-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: "unknown-kid" })
      .setSubject("user-1")
      .setIssuer(INTERNAL_TOKEN_ISSUER)
      .setAudience(INTERNAL_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(foreignPriv);

    const claims = await service.verifyToken(badKeyToken);
    expect(claims).toBeNull();
  });

  it("verifyToken returns null for an expired token", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const { SignJWT, importJWK } = await import("jose");
    const entries = JSON.parse(keysJson) as Array<{ kid: string; privateKey: JsonWebKey; publicKey: JsonWebKey }>;
    const privateKey = await importJWK(entries[0].privateKey, "EdDSA");
    const expiredToken = await new SignJWT({ orgId: "org-1", sessionId: "sess-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: entries[0].kid })
      .setSubject("user-1")
      .setIssuer(INTERNAL_TOKEN_ISSUER)
      .setAudience(INTERNAL_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 2000)
      .sign(privateKey);

    const claims = await service.verifyToken(expiredToken);
    expect(claims).toBeNull();
  });

  it("rotation overlap — older tokens verified against old key still pass", async () => {
    const { keys, kid1 } = await buildTestKeysTwo();
    const entries = JSON.parse(keys) as Array<{ kid: string; privateKey: JsonWebKey; publicKey: JsonWebKey }>;

    const { SignJWT, importJWK } = await import("jose");
    const oldPriv = await importJWK(entries[0].privateKey, "EdDSA");
    const oldToken = await new SignJWT({ orgId: "org-1", sessionId: "sess-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: kid1 })
      .setSubject("user-1")
      .setIssuer(INTERNAL_TOKEN_ISSUER)
      .setAudience(INTERNAL_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(oldPriv);

    service = await makeService(keys);
    const claims = await service.verifyToken(oldToken);
    expect(claims?.sub).toBe("user-1");
  });

  it("new tokens are signed with the latest key (last entry)", async () => {
    const { keys, kid2 } = await buildTestKeysTwo();
    service = await makeService(keys);

    const token = await service.signToken({ sub: "user-1", orgId: "org-1", sessionId: "sess-1" });
    const { decodeProtectedHeader } = await import("jose");
    const h = await decodeProtectedHeader(token);
    expect(h.kid).toBe(kid2);
  });

  it("JWKS contains only public key material", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const jwks = service.getJwks();
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0];
    expect(key).not.toHaveProperty("d");
    expect(key).toHaveProperty("x");
    expect(key?.alg).toBe("EdDSA");
    expect(key?.use).toBe("sig");
    expect(key?.kid).toBe("test-key-1");
  });

  it("a compromised frontend without the private key cannot forge a valid token", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const { SignJWT } = await import("jose");
    const forgedToken = await new SignJWT({ orgId: "org-1", sessionId: "sess-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("attacker")
      .setIssuer(INTERNAL_TOKEN_ISSUER)
      .setAudience(INTERNAL_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("x".repeat(44)));

    const claims = await service.verifyToken(forgedToken);
    expect(claims).toBeNull();
  });

  it("altered user claim (sub) invalidates token signature", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const token = await service.signToken({ sub: "real-user", orgId: "org-1", sessionId: "sess-1" });
    const [headerB64, , sigB64] = token.split(".");
    const payloadStr = Buffer.from(
      JSON.stringify({ sub: "attacker", orgId: "org-1", sessionId: "sess-1", iss: INTERNAL_TOKEN_ISSUER, aud: INTERNAL_TOKEN_AUDIENCE, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url");
    const tamperedToken = `${headerB64}.${payloadStr}.${sigB64}`;

    const claims = await service.verifyToken(tamperedToken);
    expect(claims).toBeNull();
  });

  it("altered org claim invalidates token signature", async () => {
    const keysJson = await buildTestKeys();
    service = await makeService(keysJson);

    const token = await service.signToken({ sub: "user-1", orgId: "real-org", sessionId: "sess-1" });
    const [headerB64, , sigB64] = token.split(".");
    const payloadStr = Buffer.from(
      JSON.stringify({ sub: "user-1", orgId: "evil-org", sessionId: "sess-1", iss: INTERNAL_TOKEN_ISSUER, aud: INTERNAL_TOKEN_AUDIENCE, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url");
    const tamperedToken = `${headerB64}.${payloadStr}.${sigB64}`;

    const claims = await service.verifyToken(tamperedToken);
    expect(claims).toBeNull();
  });
});
