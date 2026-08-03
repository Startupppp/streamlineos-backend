import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AttendancePolicyService } from "../attendance-policy.service";
import { HrPolicyEvaluationService } from "../../policies/hr-policy-evaluation.service";

const mockLimitFn = jest.fn().mockResolvedValue([]);
const mockWhereFn = jest.fn().mockReturnThis();
const mockSelectFn = jest.fn().mockReturnThis();
const mockFromFn = jest.fn().mockReturnThis();
const mockInnerJoinFn = jest.fn().mockReturnThis();

const mockDb = {
  select: mockSelectFn,
  from: mockFromFn,
  where: mockWhereFn,
  limit: mockLimitFn,
  innerJoin: mockInnerJoinFn,
};

const mockPolicyEval = {
  evaluatePolicy: jest.fn(),
};

describe("AttendancePolicyService — getAttendanceRules", () => {
  let service: AttendancePolicyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockLimitFn.mockResolvedValue([]);
    mockInnerJoinFn.mockReturnThis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendancePolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrPolicyEvaluationService, useValue: mockPolicyEval },
      ],
    }).compile();

    service = module.get(AttendancePolicyService);
  });

  it("returns seeded defaults when policyEval returns null", async () => {
    mockPolicyEval.evaluatePolicy.mockResolvedValueOnce(null);
    const rules = await service.getAttendanceRules("org1", "u1", "2026-07-11");

    expect(rules.graceMinutes).toBe(15);
    expect(rules.enforceGeofence).toBe(false);
    expect(rules.minReclockInMinutes).toBe(2);
    expect(rules.lateArrivalPenalty).toBe("none");
  });

  it("returns policy rules when policyEval returns a result", async () => {
    mockPolicyEval.evaluatePolicy.mockResolvedValueOnce({
      rules: { graceMinutes: 30, autoCheckoutTime: "20:00", lateArrivalPenalty: "half_day", halfDayThresholdMinutes: 300, absentThresholdMinutes: 100, enforceGeofence: true, minReclockInMinutes: 5 },
    });

    const rules = await service.getAttendanceRules("org1", "u1", "2026-07-11");
    expect(rules.graceMinutes).toBe(30);
    expect(rules.autoCheckoutTime).toBe("20:00");
    expect(rules.lateArrivalPenalty).toBe("half_day");
    expect(rules.enforceGeofence).toBe(true);
    expect(rules.minReclockInMinutes).toBe(5);
  });
});

describe("AttendancePolicyService — getOvertimeRules", () => {
  let service: AttendancePolicyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockLimitFn.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendancePolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrPolicyEvaluationService, useValue: mockPolicyEval },
      ],
    }).compile();

    service = module.get(AttendancePolicyService);
  });

  it("returns default 480 minutes when no overtime policy exists", async () => {
    mockPolicyEval.evaluatePolicy.mockResolvedValueOnce(null);
    const rules = await service.getOvertimeRules("org1", "u1", "2026-07-11");
    expect(rules.dailyThresholdMinutes).toBe(480);
  });

  it("returns policy value for dailyThresholdMinutes", async () => {
    mockPolicyEval.evaluatePolicy.mockResolvedValueOnce({ rules: { dailyThresholdMinutes: 540 } });
    const rules = await service.getOvertimeRules("org1", "u1", "2026-07-11");
    expect(rules.dailyThresholdMinutes).toBe(540);
  });
});

describe("AttendancePolicyService — getEffectiveShift", () => {
  let service: AttendancePolicyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInnerJoinFn.mockReturnThis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendancePolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrPolicyEvaluationService, useValue: mockPolicyEval },
      ],
    }).compile();

    service = module.get(AttendancePolicyService);
  });

  it("returns roster entry shift when one exists for the date", async () => {
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockInnerJoinFn.mockReturnThis();
    mockWhereFn.mockReturnThis();

    const rosterShift = { startTime: "08:00", endTime: "16:00", breakMinutes: 30, gracePeriodMinutes: 10 };
    mockLimitFn.mockResolvedValueOnce([rosterShift]);

    const result = await service.getEffectiveShift("org1", "u1", "2026-07-11");
    expect(result).toMatchObject(rosterShift);
  });

  it("falls back to employee shift assignment when no roster entry", async () => {
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockInnerJoinFn.mockReturnThis();
    mockWhereFn.mockReturnThis();

    const assignedShift = { startTime: "09:30", endTime: "18:30", breakMinutes: 60, gracePeriodMinutes: 15 };
    mockLimitFn
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([assignedShift]);

    const result = await service.getEffectiveShift("org1", "u1", "2026-07-11");
    expect(result).toMatchObject(assignedShift);
  });

  it("returns null when neither roster entry nor shift assignment exists", async () => {
    mockSelectFn.mockReturnThis();
    mockFromFn.mockReturnThis();
    mockInnerJoinFn.mockReturnThis();
    mockWhereFn.mockReturnThis();
    mockLimitFn
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.getEffectiveShift("org1", "u1", "2026-07-11");
    expect(result).toBeNull();
  });
});

describe("AttendancePolicyService — parseAutoCheckoutTimeToUtc", () => {
  let service: AttendancePolicyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendancePolicyService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: HrPolicyEvaluationService, useValue: mockPolicyEval },
      ],
    }).compile();
    service = module.get(AttendancePolicyService);
  });

  it("converts 19:00 local with +330 offset (IST) to UTC correctly", () => {
    const utcDate = service.parseAutoCheckoutTimeToUtc("19:00", "2026-07-11", 330);
    const expectedUtcHour = (19 * 60 - 330) / 60;
    expect(utcDate.getUTCHours()).toBe(Math.floor(((19 * 60 - 330 + 1440) % 1440) / 60));
    expect(utcDate.getUTCMinutes()).toBe(((19 * 60 - 330 + 1440) % 1440) % 60);
    void expectedUtcHour;
  });

  it("handles midnight boundary correctly (00:00 UTC offset 0)", () => {
    const utcDate = service.parseAutoCheckoutTimeToUtc("00:00", "2026-07-11", 0);
    expect(utcDate.getUTCHours()).toBe(0);
    expect(utcDate.getUTCMinutes()).toBe(0);
  });
});
