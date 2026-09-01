export function getMetricDefinitions() {
  return [
    { name: "headcount", formula: "COUNT(active employments)", source: "hr_employments" },
    { name: "attritionRate", formula: "exits_12m / (active + exits_12m) * 100", source: "hr_employments" },
    { name: "avgTenure", formula: "AVG(months since joining_date) for ACTIVE", source: "hr_employments" },
    { name: "leaveUtilization", formula: "consumed_days / accrued_days * 100 (YTD)", source: "hr_leave_ledger" },
    { name: "attendanceRate", formula: "PRESENT / total * 100 (last 30d)", source: "attendance" },
    { name: "openCases", formula: "COUNT(status IN open,under_investigation)", source: "hr_cases" },
    { name: "avgMood", formula: "AVG(mood) last 30d", source: "hr_mood_checkins" },
    { name: "payrollGross", formula: "gross_total of last PAID run", source: "payroll_runs" },
  ];
}
