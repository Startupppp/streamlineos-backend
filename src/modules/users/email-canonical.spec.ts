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

