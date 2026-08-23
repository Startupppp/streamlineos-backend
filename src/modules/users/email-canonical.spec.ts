import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalEmailSchema,
  createUserSchema,
  importUsersRowSchema,
  inviteUserSchema,
  bulkInviteSchema,
} from "./dto/users.schemas";

const SPELLINGS = [
  "user@example.com",
  "User@example.com",
  "USER@EXAMPLE.COM",
  "user@EXAMPLE.com",
  "User@Example.Com",
  " user@example.com",
  "user@example.com ",
  "  USER@Example.COM  ",
] as const;

const CANONICAL = "user@example.com";

describe("canonicalEmailSchema", () => {
  it.each(SPELLINGS)('canonicalises "%s"', (spelling) => {
    expect(canonicalEmailSchema.parse(spelling)).toBe(CANONICAL);
  });
});

describe("inviteUserSchema", () => {
  it.each(SPELLINGS)('canonicalises email "%s"', (spelling) => {
    const result = inviteUserSchema.parse({ email: spelling, role: "MEMBER" });
    expect(result.email).toBe(CANONICAL);
  });
});

describe("bulkInviteSchema", () => {
  it.each(SPELLINGS)('canonicalises email "%s"', (spelling) => {
    const result = bulkInviteSchema.parse({ emails: [spelling], role: "MEMBER" });
    expect(result.emails[0]).toBe(CANONICAL);
  });
});

describe("importUsersRowSchema", () => {
  it.each(SPELLINGS)('canonicalises email "%s"', (spelling) => {
    const result = importUsersRowSchema.parse({ email: spelling });
    expect(result.email).toBe(CANONICAL);
  });
});

describe("createUserSchema", () => {
  it.each(SPELLINGS)('canonicalises email "%s"', (spelling) => {
    const result = createUserSchema.parse({ email: spelling, sendInvite: false });
    expect(result.email).toBe(CANONICAL);
  });
});

describe("UsersService.createUser email canonicalisation contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src", "modules", "users", "users.service.ts"),
    "utf8",
  );
  const method = source.slice(
    source.indexOf("async createUser("),
    source.indexOf("async listUsers("),
  );

  it("does not re-canonicalise email in the service — relies on schema transform", () => {
    expect(method).not.toContain(".toLowerCase()");
    expect(method).not.toContain(".trim()");
  });

  it("probes the users table with the email directly from parsed input", () => {
    expect(method).toContain("eq(users.email, email)");
  });

  it("inserts the email value directly from parsed input", () => {
    expect(method).toContain("email,");
  });
});
