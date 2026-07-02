import { formatDayMonthYear, formatDayMonthYearTime } from "./date.helpers";

export interface ProfileEmployee {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  role: string;
  designation: string | null;
  employeeId: string | null;
  joiningDate: string | null;
  reportingTo: string | null;
  monthlySalary: string | null;
  isActive: boolean;
  bio: string | null;
  linkedinUrl: string | null;
  phone: string | null;
}

export function buildEmployeeProfileHtml(
  employee: ProfileEmployee,
  skills: { name: string; level: number }[],
): string {
  const name =
    employee.name ?? (`${employee.firstName ?? ""} ${employee.lastName ?? ""}`.trim() || "Employee");
  const joinDate = employee.joiningDate ? formatDayMonthYear(new Date(employee.joiningDate)) : "—";

  const skillsList =
    skills.length > 0
      ? skills.map((s) => `<span class="badge">${s.name}</span>`).join(" ")
      : "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Employee Profile — ${name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: "Segoe UI", Arial, sans-serif; font-size: 14px; color: #111; background: #fff; padding: 32px; }
    h1 { font-size: 22px; font-weight: 700; color: #0f2b7f; margin-bottom: 4px; }
    .subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
    .section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #bd882c; margin-bottom: 8px; margin-top: 20px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin-bottom: 8px; }
    .field-label { font-size: 11px; color: #888; margin-bottom: 2px; }
    .field-value { font-size: 13px; color: #111; }
    .badge { display: inline-block; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 4px; padding: 2px 8px; font-size: 12px; color: #374151; margin-right: 4px; }
    .bio { font-size: 13px; color: #444; line-height: 1.6; white-space: pre-wrap; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <div class="subtitle">${employee.designation ?? "—"} · ${employee.email ?? "—"}</div>

  <div class="section-title">Personal Information</div>
  <div class="grid">
    <div>
      <div class="field-label">Employee ID</div>
      <div class="field-value">${employee.employeeId ?? employee.id ?? "—"}</div>
    </div>
    <div>
      <div class="field-label">Email</div>
      <div class="field-value">${employee.email ?? "—"}</div>
    </div>
    <div>
      <div class="field-label">Phone</div>
      <div class="field-value">${employee.phone ?? "—"}</div>
    </div>
    <div>
      <div class="field-label">LinkedIn</div>
      <div class="field-value">${employee.linkedinUrl ?? "—"}</div>
    </div>
  </div>

  <div class="section-title">Employment Details</div>
  <div class="grid">
    <div>
      <div class="field-label">Role</div>
      <div class="field-value">${employee.role ?? "—"}</div>
    </div>
    <div>
      <div class="field-label">Designation</div>
      <div class="field-value">${employee.designation ?? "—"}</div>
    </div>
    <div>
      <div class="field-label">Joining Date</div>
      <div class="field-value">${joinDate}</div>
    </div>
    <div>
      <div class="field-label">Status</div>
      <div class="field-value">${employee.isActive ? "Active" : "Inactive"}</div>
    </div>
    <div>
      <div class="field-label">Monthly Salary</div>
      <div class="field-value">${employee.monthlySalary ? `₹${employee.monthlySalary}` : "—"}</div>
    </div>
    <div>
      <div class="field-label">Reports To</div>
      <div class="field-value">${employee.reportingTo ?? "—"}</div>
    </div>
  </div>

  ${employee.bio ? `<div class="section-title">Bio</div><div class="bio">${employee.bio}</div>` : ""}

  <div class="section-title">Skills</div>
  <div>${skillsList}</div>

  <div style="margin-top:32px;font-size:11px;color:#aaa;border-top:1px solid #e5e7eb;padding-top:12px;">
    Generated on ${formatDayMonthYearTime(new Date())} — Confidential HR Record
  </div>
</body>
</html>`;
}
