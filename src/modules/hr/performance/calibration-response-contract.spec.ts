import { checkResponseAgainstContract } from "../../../common/openapi/response-contract.interceptor";
import { hrCalibrationEntries } from "../../../db/schema/hr/performance";
import type { CalibrationService } from "./calibration.service";
import {
  getNineBoxResponseSchema,
  listCalibrationEntriesResponseSchema,
  upsertCalibrationEntryResponseSchema,
} from "./dto/calibration-response.schemas";

// Fixtures are typed from the Drizzle row and the service return type, so a rename fails to compile here instead of drifting.
describe("calibration response contracts", () => {
  const entry: typeof hrCalibrationEntries.$inferSelect = {
    id: 7,
    orgId: "org_1",
    cycleId: 3,
    employeeId: "user_1",
    employeeMembershipId: null,
    preRating: "3.0",
    postRating: "4.5",
    calibratedBy: "user_2",
    note: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };

  type NineBoxRow = Awaited<ReturnType<CalibrationService["getNineBox"]>>[number];
  const nineBox: NineBoxRow = {
    employeeId: "user_1",
    performance: 4.2,
    potential: 4.5,
    box: "3-3",
    note: null,
  };

  it("accepts the row listEntries selects", () => {
    expect(checkResponseAgainstContract(listCalibrationEntriesResponseSchema, [entry])).toBeNull();
  });

  it("accepts the row upsertEntry returns", () => {
    expect(checkResponseAgainstContract(upsertCalibrationEntryResponseSchema, entry)).toBeNull();
  });

  it("accepts the shape getNineBox builds", () => {
    expect(checkResponseAgainstContract(getNineBoxResponseSchema, [nineBox])).toBeNull();
  });

  it("rejects the retired field names", () => {
    const retired = {
      id: 7,
      orgId: "org_1",
      cycleId: 3,
      userId: "user_1",
      userMembershipId: null,
      performanceScore: "3.0",
      potentialScore: "4.5",
      box: null,
      note: null,
      calibratedBy: "user_2",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    expect(checkResponseAgainstContract(listCalibrationEntriesResponseSchema, [retired])).toContain(
      "0.employeeId: invalid_type",
    );
  });

  it("rejects nine-box scores sent as strings", () => {
    const stringScores = { ...nineBox, performance: "4.2", potential: "4.5" };
    expect(checkResponseAgainstContract(getNineBoxResponseSchema, [stringScores])).toContain(
      "0.performance: invalid_type",
    );
  });
});
