/**
 * ExitService – actor contraction spec.
 *
 * Verifies that list() uses dual-read (userMembershipId OR userId) when
 * membershipId is provided and the caller is not an admin.
 */

import { ExitService } from "./exit.service";
import type { ListResignationsQueryInput } from "./dto/exit.schemas";

const ORG_ID = "org-exit-test";
const USER_ID = "user-exit";
const ACTIVE_MEMBERSHIP_ID = 11;

function makeBaseParams(): ListResignationsQueryInput {
  return { page: 1, limit: 20, status: undefined };
}

function buildDbMock(rows: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const selectChain = {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([{ total: rows.length }]),
    }),
  };

  return {
    query: {
      resignations: { findMany },
    },
    select: jest.fn().mockReturnValue(selectChain),
  };
}

describe("ExitService – actor contraction dual-read", () => {
  const mockEmployment = { resolveFacts: jest.fn() };

  it("filters by userMembershipId when membershipId is provided and caller is not admin", async () => {
    const mockDb = buildDbMock([]);
    const service = new ExitService(mockDb as never, mockEmployment as never);

    const result = await service.list(ORG_ID, USER_ID, false, makeBaseParams(), ACTIVE_MEMBERSHIP_ID);

    expect(result.data).toHaveLength(0);
    expect(mockDb.query.resignations.findMany).toHaveBeenCalled();
  });

  it("does not add owner filter when isAdmin=true (regardless of membershipId)", async () => {
    const mockDb = buildDbMock([]);
    const service = new ExitService(mockDb as never, mockEmployment as never);

    const result = await service.list(ORG_ID, USER_ID, true, makeBaseParams(), ACTIVE_MEMBERSHIP_ID);

    expect(result.data).toHaveLength(0);
  });

  it("falls back to userId-only predicate when membershipId is null", async () => {
    const mockDb = buildDbMock([]);
    const service = new ExitService(mockDb as never, mockEmployment as never);

    const result = await service.list(ORG_ID, USER_ID, false, makeBaseParams(), null);

    expect(result.data).toHaveLength(0);
    expect(mockDb.query.resignations.findMany).toHaveBeenCalled();
  });
});
