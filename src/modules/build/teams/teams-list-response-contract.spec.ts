import { TeamsService } from "./teams.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { teamPageSchema } from "./dto/teams-response.schemas";
import { checkResponseAgainstContract } from "../../../common/openapi/response-contract.interceptor";

const STORED_ROW = {
  id: 7,
  orgId: "org-1",
  name: "Delivery Squad",
  key: "DELIV",
  icon: null,
  color: null,
  isPrivate: false,
  createdAt: new Date("2026-09-18T10:00:00.000Z"),
  updatedAt: new Date("2026-09-18T10:00:00.000Z"),
  deletedAt: null,
  memberCount: 0,
};

function dbReturning(rows: unknown[]): Db {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  return { select: jest.fn((projection: Record<string, unknown>) => {
    builder.limit = jest.fn().mockResolvedValue(
      rows.map((row) => Object.fromEntries(
        Object.keys(projection).map((key) => [key, (row as Record<string, unknown>)[key]]),
      )),
    );
    return builder;
  }) } as unknown as Db;
}

async function listOneTeam() {
  const svc = new TeamsService(dbReturning([STORED_ROW]), {} as AuditService);
  return svc.listTeams("org-1", { cursor: undefined, pageSize: 50, search: undefined }, 1);
}

describe("GET /build/teams — the page the handler returns is the page its contract promises", () => {
  it("satisfies teamPageSchema once a single team exists, so creating the first team does not break the list", async () => {
    const page = await listOneTeam();
    expect(checkResponseAgainstContract(teamPageSchema, page)).toBeNull();
  });

  it("carries the member count the Members column renders, rather than dropping it at the contract", async () => {
    const page = await listOneTeam();
    expect(teamPageSchema.parse(page).data[0]).toHaveProperty("memberCount");
  });

  it("bite proof: a row missing a field the contract requires is reported, not waved through", () => {
    const missingName = { data: [{ ...STORED_ROW, name: undefined }], pagination: { limit: 50, hasMore: false, nextCursor: null } };
    expect(checkResponseAgainstContract(teamPageSchema, missingName)).not.toBeNull();
  });
});
