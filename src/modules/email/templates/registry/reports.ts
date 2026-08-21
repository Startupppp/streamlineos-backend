import {
  getAttendanceReportTemplate,
  getMonthlyExpenseReportTemplate,
  getWeeklyRecapEmailTemplate,
} from "../index";
import type { TemplateEntry } from "./_shared";

export const reportsTemplates: Record<string, TemplateEntry> = {
  "reports.weekly_attendance": {
    category: "Reports",
    name: "Weekly Attendance Report",
    subject: "Attendance report — week of 30 Jun 2026",
    generateHtml: () =>
      getAttendanceReportTemplate("30 Jun – 4 Jul 2026", "Acme Corp", [
        {
          department: "Engineering",
          name: "Priya Sharma",
          totalHours: "42h 30m",
          autoCheckoutDays: 0,
          overtimeDays: 2,
          daysPresent: 5,
        },
        {
          department: "Sales",
          name: "Rahul Verma",
          totalHours: "38h 00m",
          autoCheckoutDays: 1,
          overtimeDays: 0,
          daysPresent: 5,
        },
      ]),
  },
  "reports.monthly_expense": {
    category: "Reports",
    name: "Monthly Expense Report",
    subject: "Expense report — June 2026",
    generateHtml: () =>
      getMonthlyExpenseReportTemplate(
        "June 2026",
        "Acme Corp",
        [
          {
            date: "2 Jun 2026",
            employeeName: "Priya Sharma",
            category: "Travel",
            amount: "1,500",
            currency: "INR",
            status: "APPROVED",
          },
          {
            date: "10 Jun 2026",
            employeeName: "Rahul Verma",
            category: "Meals",
            amount: "800",
            currency: "INR",
            status: "PAID",
          },
        ],
        {
          totalAmount: "2,300",
          totalCount: 2,
          pendingCount: 0,
          approvedCount: 1,
          paidCount: 1,
          rejectedCount: 0,
        },
      ),
  },
  "reports.weekly_recap": {
    category: "Reports",
    name: "Weekly Business Recap",
    subject: "Your week at Acme Corp",
    generateHtml: () =>
      getWeeklyRecapEmailTemplate({
        orgName: "Acme Corp",
        weekRange: "30 Jun – 4 Jul 2026",
        totalEmployees: 48,
        newLeads: 12,
        convertedLeads: 3,
        totalActivities: 27,
        openTickets: 5,
        closedTickets: 9,
        pendingLeaves: 2,
        topPerformers: [
          { name: "Rahul Verma", score: 142 },
          { name: "Sana Sheikh", score: 118 },
        ],
        pipelineSummary: [
          { status: "New", count: 8 },
          { status: "Qualified", count: 5 },
          { status: "Negotiation", count: 3 },
        ],
        aiNarrative: "Strong week with 3 deals converted and 12 new inbound leads.",
      }),
  },
};
