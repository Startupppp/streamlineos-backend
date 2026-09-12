import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  ARCHIVED_MEMBER_MESSAGE,
} from "../../organization/core/membership-admission.service";
import {
  ALREADY_EMPLOYEE_MESSAGE,
  ATTACH_CONFIRMATION_REQUIRED_MESSAGE,
} from "./employee-admission-status";
import { buildService, makeHarness } from "./employee-onboarding.spec-fixtures";

const ORG_ID = "org-attach";
const ACTOR = { orgId: ORG_ID, userId: "actor-1", isOrgOwner: true };
const EXISTING_USER_ID = "user-existing-1";

const BODY = {
  firstName: "Jane",
  lastName: "Doe",
  email: "Jane.Doe@Example.com",
  designation: "Engineer",
  whatsappSameAsPhone: true,
  dateOfBirth: "1990-04-01",
  gender: "FEMALE",
  phone: "+919000000000",
};

describe("attach employment to somebody who already exists — P4 acceptance", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("an existing ACTIVE member of this organization, without confirmation", () => {
    it("is refused and told to confirm attaching, before any employment is written", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, { status: "ACTIVE" }],
      });
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, BODY as never),
      ).rejects.toThrow(new ConflictException(ATTACH_CONFIRMATION_REQUIRED_MESSAGE));

      expect(ensureFromUser).not.toHaveBeenCalled();
    });

    it("creates no organization person, HR person or employment row", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, { status: "ACTIVE" }],
      });
      const { service } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, BODY as never),
      ).rejects.toThrow(ConflictException);

      const written = harness.inserted.map((row) => row.table);
      expect(written).not.toContain("hr_employments");
      expect(written).not.toContain("hr_people");
      expect(written).not.toContain("organization_people");
      expect(written).not.toContain("organization_members");
    });

    it("grants no additional seat", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, { status: "ACTIVE" }],
      });
      const { service, recordSeatEvents, assertWithinLimit } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, BODY as never),
      ).rejects.toThrow(ConflictException);

      expect(recordSeatEvents).not.toHaveBeenCalled();
      expect(assertWithinLimit).not.toHaveBeenCalled();
    });
  });

  describe("a suspended or departed local member", () => {
    it("receives restore guidance rather than a silent reactivation when SUSPENDED", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, { status: "SUSPENDED" }],
      });
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, BODY as never),
      ).rejects.toThrow(new ConflictException(ARCHIVED_MEMBER_MESSAGE));

      expect(ensureFromUser).not.toHaveBeenCalled();
      expect(harness.updated.map((row) => row.table)).not.toContain("organization_members");
    });

    it("receives restore guidance when the membership status is LEFT", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, { status: "LEFT" }],
      });
      const { service } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, BODY as never),
      ).rejects.toThrow(new ConflictException(ARCHIVED_MEMBER_MESSAGE));
    });
  });

  describe("an existing EXTERNAL account that belongs to another organization", () => {
    function externalHarness(isActive: boolean) {
      return makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, null],
        selects: {
          users: [[{ isActive }]],
          organization_members: [[]],
        },
        returning: {
          organization_members: [{ id: 77, userId: EXISTING_USER_ID }],
        },
      });
    }

    it("never rewrites the global users row when the account is globally active", async () => {
      const harness = externalHarness(true);
      const { service } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, BODY as never),
      ).resolves.toEqual({ success: true, userId: EXISTING_USER_ID });

      expect(harness.updated.map((row) => row.table)).not.toContain("users");
      expect(harness.inserted.map((row) => row.table)).not.toContain("users");
    });

    it("attaches employment through the canonical person/employment owner", async () => {
      const harness = externalHarness(true);
      const { service, ensureFromUser } = buildService(harness.db);

      await service.onboardEmployee(ACTOR as never, BODY as never);

      expect(ensureFromUser).toHaveBeenCalledTimes(1);
      expect(ensureFromUser).toHaveBeenCalledWith(
        ORG_ID,
        ACTOR.userId,
        expect.objectContaining({
          userId: EXISTING_USER_ID,
          workEmail: BODY.email,
          lifecycleStatus: "ONBOARDING",
        }),
      );
    });

    it("mints no login for an account that already has one", async () => {
      const harness = externalHarness(true);
      const { service } = buildService(harness.db);

      await service.onboardEmployee(ACTOR as never, BODY as never);

      expect(harness.inserted.map((row) => row.table)).not.toContain("magic_link_tokens");
    });

    it("refuses a globally suspended account instead of reactivating it", async () => {
      const harness = externalHarness(false);
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, BODY as never),
      ).rejects.toThrow(BadRequestException);

      expect(harness.updated.map((row) => row.table)).not.toContain("users");
      expect(ensureFromUser).not.toHaveBeenCalled();
    });
  });

  describe("an explicit employee number already held by a different person", () => {
    it("is refused before employment is attached", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, null],
        selects: {
          users: [[{ isActive: true }]],
          hr_employments: [[{ userId: "someone-else" }]],
        },
        returning: {
          organization_members: [{ id: 78, userId: EXISTING_USER_ID }],
        },
      });
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, {
          ...BODY,
          employeeId: "EMP-0001",
        } as never),
      ).rejects.toThrow(ConflictException);

      expect(ensureFromUser).not.toHaveBeenCalled();
    });

    it("is allowed when the live primary employment belongs to the same person", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, null],
        selects: {
          users: [[{ isActive: true }]],
          hr_employments: [[{ userId: EXISTING_USER_ID }]],
        },
        returning: {
          organization_members: [{ id: 79, userId: EXISTING_USER_ID }],
        },
      });
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, {
          ...BODY,
          employeeId: "EMP-0001",
        } as never),
      ).resolves.toEqual({ success: true, userId: EXISTING_USER_ID });

      expect(ensureFromUser).toHaveBeenCalledWith(
        ORG_ID,
        ACTOR.userId,
        expect.objectContaining({ employeeNumber: "EMP-0001" }),
      );
    });
  });

  describe("an existing ACTIVE member, with the attach confirmed", () => {
    function attachHarness(employmentRows: unknown[][]) {
      return makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, { status: "ACTIVE" }],
        selects: {
          users: [[{ isActive: true }]],
          hr_employments: employmentRows,
        },
      });
    }

    const ATTACH_BODY = { ...BODY, attachToExistingMember: true };

    it("attaches employment through the canonical person/employment owner", async () => {
      const harness = attachHarness([[]]);
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, ATTACH_BODY as never),
      ).resolves.toEqual({ success: true, userId: EXISTING_USER_ID });

      expect(ensureFromUser).toHaveBeenCalledTimes(1);
      expect(ensureFromUser).toHaveBeenCalledWith(
        ORG_ID,
        ACTOR.userId,
        expect.objectContaining({
          userId: EXISTING_USER_ID,
          workEmail: BODY.email,
          lifecycleStatus: "ONBOARDING",
        }),
      );
    });

    it("takes no extra seat and writes no second membership or login", async () => {
      const harness = attachHarness([[]]);
      const { service, recordSeatEvents, assertWithinLimit } = buildService(harness.db);

      await service.onboardEmployee(ACTOR as never, ATTACH_BODY as never);

      expect(recordSeatEvents).not.toHaveBeenCalled();
      expect(assertWithinLimit).not.toHaveBeenCalled();
      const written = harness.inserted.map((row) => row.table);
      expect(written).not.toContain("organization_members");
      expect(written).not.toContain("users");
      expect(written).not.toContain("magic_link_tokens");
    });

    it("never rewrites the global users row", async () => {
      const harness = attachHarness([[]]);
      const { service } = buildService(harness.db);

      await service.onboardEmployee(ACTOR as never, ATTACH_BODY as never);

      expect(harness.updated.map((row) => row.table)).not.toContain("users");
    });

    it("refuses when that member already holds a live primary employment", async () => {
      const harness = attachHarness([[{ employmentId: 42 }]]);
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, ATTACH_BODY as never),
      ).rejects.toThrow(new ConflictException(ALREADY_EMPLOYEE_MESSAGE));

      expect(ensureFromUser).not.toHaveBeenCalled();
      expect(harness.inserted.map((row) => row.table)).not.toContain("hr_employments");
    });

    it("does not turn a suspended member into an attach", async () => {
      const harness = makeHarness({
        findFirst: [{ id: EXISTING_USER_ID }, { status: "SUSPENDED" }],
      });
      const { service, ensureFromUser } = buildService(harness.db);

      await expect(
        service.onboardEmployee(ACTOR as never, ATTACH_BODY as never),
      ).rejects.toThrow(new ConflictException(ARCHIVED_MEMBER_MESSAGE));

      expect(ensureFromUser).not.toHaveBeenCalled();
    });

    it("does not attach when the address belongs to nobody in this organization", async () => {
      const harness = makeHarness({
        findFirst: [null],
        selects: { organization_members: [[]] },
        returning: { organization_members: [{ id: 80, userId: "created-1" }] },
      });
      const { service, recordSeatEvents } = buildService(harness.db);

      await service.onboardEmployee(ACTOR as never, ATTACH_BODY as never);

      expect(recordSeatEvents).toHaveBeenCalled();
    });
  });
});
