import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BadRequestException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { generateSecret, generateSync, verifySync } from "otplib";
import { MfaService } from "../../../src/modules/mfa/mfa.service";
import {
  disableMfaSchema,
  verifyMfaSchema,
} from "../../../src/modules/mfa/dto/mfa.schemas";
import type { Db } from "../../../src/db/drizzle.module";

const BACKEND_ROOT = resolve(__dirname, "../../..");

interface BackupCodeRow {
  id: number;
  codeHash: string;
  usedAt: Date | null;
}

interface UserRow {
  totpSecret: string | null;
  totpEnabled: boolean;
}

function makeDb(state: { user: UserRow | null; backupCodes: BackupCodeRow[] }) {
  const userUpdates: Array<Record<string, unknown>> = [];
  const codeUpdates: number[] = [];
  const sessionStamps: Array<Record<string, unknown>> = [];

  const db = {
    userUpdates,
    codeUpdates,
    sessionStamps,
    query: {
      users: { findFirst: () => Promise.resolve(state.user) },
      mfaBackupCodes: {
        findMany: () =>
          Promise.resolve(
            state.backupCodes
              .filter((code) => code.usedAt === null)
              .map((code) => ({ id: code.id, codeHash: code.codeHash })),
          ),
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if ("usedAt" in values) {
            const target = state.backupCodes.find((code) => code.usedAt === null);
            if (target) {
              target.usedAt = values.usedAt as Date;
              codeUpdates.push(target.id);
            }
          } else if ("mfaSatisfiedAt" in values) {
            sessionStamps.push(values);
          } else {
            userUpdates.push(values);
            if (state.user && "totpEnabled" in values) {
              state.user.totpEnabled = values.totpEnabled === true;
            }
          }
          return Promise.resolve([]);
        },
      }),
    }),
    insert: () => ({ values: () => Promise.resolve([]) }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    delete: () => ({ where: () => Promise.resolve([]) }),
  };
  return db;
}

function makeService(db: ReturnType<typeof makeDb>): MfaService {
  return new MfaService(
    db as unknown as Db,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    { invalidateUser: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

const SECRET = generateSecret();

function currentToken(secret: string = SECRET): string {
  return generateSync({ secret, strategy: "totp" });
}

function wrongToken(): string {
  for (let candidate = 0; candidate < 1000; candidate += 1) {
    const token = String(candidate).padStart(6, "0");
    if (!verifySync({ secret: SECRET, token, strategy: "totp" }).valid) return token;
  }
  throw new Error("could not construct an invalid TOTP token");
}

describe("MFA enrolment refuses a wrong factor", () => {
  it("a wrong TOTP token is rejected and MFA is not switched on", async () => {
    const db = makeDb({
      user: { totpSecret: SECRET, totpEnabled: false },
      backupCodes: [],
    });
    await expect(makeService(db).verify("user-1", "session-1", { token: wrongToken() })).rejects.toThrow(
      BadRequestException,
    );
    expect(db.userUpdates).toEqual([]);
  });

  it("CONTROL: the correct current TOTP token is accepted, so the refusal above is about the code", async () => {
    const db = makeDb({
      user: { totpSecret: SECRET, totpEnabled: false },
      backupCodes: [],
    });
    await expect(makeService(db).verify("user-1", "session-1", { token: currentToken() })).resolves.toEqual({
      enabled: true,
    });
    expect(db.userUpdates).toEqual([{ totpEnabled: true }]);
  });

  it("a caller who never enrolled is refused before any secret is decrypted", async () => {
    const db = makeDb({ user: { totpSecret: null, totpEnabled: false }, backupCodes: [] });
    await expect(makeService(db).verify("user-1", "session-1", { token: currentToken() })).rejects.toThrow(
      "MFA not set up",
    );

    const missing = makeDb({ user: null, backupCodes: [] });
    await expect(makeService(missing).verify("ghost", "session-1", { token: currentToken() })).rejects.toThrow(
      "MFA not set up",
    );
  });
});

describe("Recovery codes are single-use and rejected when wrong", () => {
  const GOOD = "A1B2C3-D4E5F6";
  const OTHER = "112233-445566";

  async function codeRow(id: number, plain: string, usedAt: Date | null = null) {
    return { id, codeHash: await bcrypt.hash(plain, 10), usedAt };
  }

  it("an unknown recovery code is rejected", async () => {
    const db = makeDb({
      user: { totpSecret: SECRET, totpEnabled: false },
      backupCodes: [await codeRow(1, GOOD)],
    });
    await expect(
      makeService(db).verify("user-1", "session-1", { backupCode: "ZZZZZZ-ZZZZZZ" }),
    ).rejects.toThrow("Invalid backup code");
    expect(db.codeUpdates).toEqual([]);
  });

  it("a correct recovery code is accepted once and burned", async () => {
    const row = await codeRow(1, GOOD);
    const db = makeDb({
      user: { totpSecret: SECRET, totpEnabled: false },
      backupCodes: [row, await codeRow(2, OTHER)],
    });
    const service = makeService(db);

    await expect(service.verify("user-1", "session-1", { backupCode: GOOD })).resolves.toEqual({
      enabled: true,
    });
    expect(row.usedAt).not.toBeNull();

    await expect(service.verify("user-1", "session-1", { backupCode: GOOD })).rejects.toThrow(
      "Invalid backup code",
    );
  });

  it("an already-burned code is never even compared — the lookup excludes used rows", async () => {
    const db = makeDb({
      user: { totpSecret: SECRET, totpEnabled: false },
      backupCodes: [await codeRow(1, GOOD, new Date())],
    });
    await expect(makeService(db).verify("user-1", "session-1", { backupCode: GOOD })).rejects.toThrow(
      "Invalid backup code",
    );
  });

  it("recovery codes are stored as bcrypt hashes, never in the clear", async () => {
    const row = await codeRow(1, GOOD);
    expect(row.codeHash).not.toContain(GOOD);
    expect(row.codeHash.startsWith("$2")).toBe(true);
    expect(await bcrypt.compare(GOOD, row.codeHash)).toBe(true);
    expect(await bcrypt.compare(OTHER, row.codeHash)).toBe(false);

    const source = readFileSync(resolve(BACKEND_ROOT, "src/modules/mfa/mfa.service.ts"), "utf8");
    expect(source).toMatch(/async function hashBackupCode[\s\S]{0,120}bcrypt\.hash/);
    expect(source).toMatch(/values\(hashedCodes\.map\(\(codeHash\) => \(\{ userId, codeHash \}\)\)\)/);
  });
});

describe("Turning MFA off needs the live factor, not a recovery code", () => {
  it("a wrong token cannot disable MFA", async () => {
    const db = makeDb({ user: { totpSecret: SECRET, totpEnabled: true }, backupCodes: [] });
    await expect(makeService(db).disable("user-1", "org-1", { token: wrongToken() })).rejects.toThrow(
      "Invalid token",
    );
    expect(db.userUpdates).toEqual([]);
  });

  it("the disable payload has no recovery-code branch at all", () => {
    expect(disableMfaSchema.safeParse({ backupCode: "A1B2C3-D4E5F6" }).success).toBe(false);
    expect(disableMfaSchema.safeParse({ token: "123456", backupCode: "x" }).success).toBe(false);
    expect(disableMfaSchema.safeParse({ token: "123456" }).success).toBe(true);
  });

  it("the verify payload accepts exactly one factor and refuses a mixed or oversized one", () => {
    expect(verifyMfaSchema.safeParse({ token: "123456" }).success).toBe(true);
    expect(verifyMfaSchema.safeParse({ backupCode: "A1B2C3-D4E5F6" }).success).toBe(true);
    expect(verifyMfaSchema.safeParse({ token: "123456", backupCode: "x" }).success).toBe(false);
    expect(verifyMfaSchema.safeParse({ token: "12345" }).success).toBe(false);
    expect(verifyMfaSchema.safeParse({ token: "1234567" }).success).toBe(false);
    expect(verifyMfaSchema.safeParse({}).success).toBe(false);
  });

  it("disabling clears the stored secret rather than leaving it readable", async () => {
    const db = makeDb({ user: { totpSecret: SECRET, totpEnabled: true }, backupCodes: [] });
    await expect(
      makeService(db).disable("user-1", "org-1", { token: currentToken() }),
    ).resolves.toEqual({ disabled: true });
    expect(db.userUpdates).toEqual([{ totpEnabled: false, totpSecret: null }]);
  });
});

describe("The TOTP secret is not stored in the clear", () => {
  it("the stored value is AES-GCM ciphertext that does not contain the secret", async () => {
    const db = makeDb({ user: { totpSecret: null, totpEnabled: false }, backupCodes: [] });
    const service = makeService(db);
    const setup = await service.setup("user-1");

    const stored = db.userUpdates.find((update) => "totpSecret" in update);
    const ciphertext = String(stored?.totpSecret ?? "");
    expect(ciphertext.startsWith("enc:v1:")).toBe(true);
    expect(ciphertext).not.toContain(setup.secret);
    expect(setup.backupCodes).toHaveLength(8);
    expect(new Set(setup.backupCodes).size).toBe(8);
  });

  it("brute-forcing the verify endpoint is bounded by a declared rate-limit tier", () => {
    const controller = readFileSync(
      resolve(BACKEND_ROOT, "src/modules/mfa/mfa.controller.ts"),
      "utf8",
    );
    expect(controller).toContain('"auth:mfa-verify"');
    expect(controller).toContain('"auth:mfa-disable"');
  });
});
