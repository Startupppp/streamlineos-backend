import { Test } from "@nestjs/testing";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { SessionsService } from "../../sessions/sessions.service";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { OrgMembershipService } from "./org-membership.service";
import { AblyService } from "../../realtime/ably.service";

describe("OrgMembershipService access revocation", () => {
  it("evicts only the requested organization without revoking account sessions", async () => {
    const where = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const revokeAllForUser = jest.fn();
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const tx = { execute: jest.fn().mockResolvedValue([]), update };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgMembershipService,
        { provide: AblyService, useValue: { revokeUserTokens: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            sendMembershipRemovedEmail: jest.fn().mockResolvedValue(undefined),
            sendMembershipSuspendedEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: DRIZZLE,
          useValue: {
            transaction: jest
              .fn()
              .mockImplementation(
                (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
              ),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: { invalidate, invalidateNamespace: jest.fn() },
        },
        { provide: SessionsService, useValue: { revokeAllForUser } },
        { provide: AccessService, useValue: {} },
      ],
    }).compile();
    const service = moduleRef.get(OrgMembershipService);

    await service.revokeOrgScopedAccess("org-1", "member-1");

    expect(update).toHaveBeenCalledTimes(1);
    expect(revokeAllForUser).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
  });
});
