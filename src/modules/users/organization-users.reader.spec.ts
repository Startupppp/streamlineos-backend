import { NotFoundException } from "@nestjs/common";
import { OrganizationUsersReader } from "./organization-users.reader";

const makeMemberRow = (emailVerifiedAt: Date | null) => ({
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  emailVerifiedAt,
  firstName: "Test",
  lastName: "User",
  image: null,
  role: "MEMBER",
  isOwner: false,
  phone: null,
  whatsappNumber: null,
  whatsappSameAsPhone: false,
  membershipStatus: "ACTIVE" as const,
  membershipLeftAt: null,
  team: null,
  emergencyContact: null,
  bio: null,
  linkedinUrl: null,
  twitterUrl: null,
  githubUrl: null,
  websiteUrl: null,
  totpEnabled: false,
  dateOfBirth: null,
  gender: null,
  onboardingDocStatus: null,
  onboardingCompletedAt: null,
  invitedAt: null,
  activatedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  isProfilePictureRequired: false,
  memberRole: "MEMBER",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const makeFactsMock = () =>
  ({
    getFacts: jest.fn().mockResolvedValue({
      departmentId: null,
      designation: null,
      employeeNumber: null,
      managerUserId: null,
      joiningDate: null,
      locationId: null,
    }),
  }) as any;

const makeDbChain = (rows: unknown[]) => {
  const chain: Record<string, unknown> = {};
  const terminal = jest.fn().mockResolvedValue(rows);
  for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain["limit"] = terminal;
  return chain;
};

describe("OrganizationUsersReader.getUser — emailVerified wire type", () => {
  it("produces a JS boolean true when email_verified timestamp is present", async () => {
    const verifiedAt = new Date("2026-06-01T12:00:00.000Z");
    const chain = makeDbChain([makeMemberRow(verifiedAt)]);
    const mockDb = { select: jest.fn().mockReturnValue(chain) } as any;

    const reader = new OrganizationUsersReader(mockDb, makeFactsMock());
    const result = await reader.getUser("org-1", "user-1");

    expect(typeof result.emailVerified).toBe("boolean");
    expect(result.emailVerified).toBe(true);
  });

  it("produces a JS boolean false when email_verified is null", async () => {
    const chain = makeDbChain([makeMemberRow(null)]);
    const mockDb = { select: jest.fn().mockReturnValue(chain) } as any;

    const reader = new OrganizationUsersReader(mockDb, makeFactsMock());
    const result = await reader.getUser("org-1", "user-1");

    expect(typeof result.emailVerified).toBe("boolean");
    expect(result.emailVerified).toBe(false);
  });

  it("never produces a string for emailVerified regardless of emailVerifiedAt input shape", async () => {
    for (const emailVerifiedAt of [new Date(), null]) {
      const chain = makeDbChain([makeMemberRow(emailVerifiedAt)]);
      const mockDb = { select: jest.fn().mockReturnValue(chain) } as any;

      const reader = new OrganizationUsersReader(mockDb, makeFactsMock());
      const result = await reader.getUser("org-1", "user-1");

      expect(typeof result.emailVerified).not.toBe("string");
      expect(typeof result.emailVerified).toBe("boolean");
    }
  });

  it("throws NotFoundException when the user is not in the org", async () => {
    const chain = makeDbChain([]);
    const mockDb = { select: jest.fn().mockReturnValue(chain) } as any;

    const reader = new OrganizationUsersReader(mockDb, makeFactsMock());

    await expect(reader.getUser("org-1", "user-missing")).rejects.toThrow(NotFoundException);
  });
});
