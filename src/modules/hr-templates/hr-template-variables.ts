export interface TemplateVariable {
  token: string;
  label: string;
  group: string;
  sensitive: boolean;
  example: string;
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { token: "employee.firstName", label: "First Name", group: "Employee", sensitive: false, example: "Priya" },
  { token: "employee.lastName", label: "Last Name", group: "Employee", sensitive: false, example: "Sharma" },
  { token: "employee.fullName", label: "Full Name", group: "Employee", sensitive: false, example: "Priya Sharma" },
  { token: "employee.workEmail", label: "Work Email", group: "Employee", sensitive: false, example: "priya@streamlineos.app" },
  { token: "employee.employeeNumber", label: "Employee Number", group: "Employee", sensitive: false, example: "EMP-0042" },
  { token: "employee.designation", label: "Designation", group: "Employee", sensitive: false, example: "Senior Engineer" },
  { token: "employee.joiningDate", label: "Joining Date", group: "Employee", sensitive: false, example: "1 April 2024" },
  { token: "employee.probationEndDate", label: "Probation End Date", group: "Employee", sensitive: false, example: "1 July 2024" },
  { token: "employee.lastWorkingDay", label: "Last Working Day", group: "Employee", sensitive: false, example: "31 March 2025" },
  { token: "employee.phone", label: "Phone", group: "Employee", sensitive: true, example: "+91 98765 43210" },
  { token: "employee.dateOfBirth", label: "Date of Birth", group: "Employee", sensitive: true, example: "15 August 1990" },

  { token: "manager.fullName", label: "Manager Full Name", group: "Manager", sensitive: false, example: "Rahul Verma" },
  { token: "manager.designation", label: "Manager Designation", group: "Manager", sensitive: false, example: "Engineering Manager" },
  { token: "manager.workEmail", label: "Manager Email", group: "Manager", sensitive: false, example: "rahul@streamlineos.app" },

  { token: "department.name", label: "Department Name", group: "Department", sensitive: false, example: "Engineering" },

  { token: "role.title", label: "Role Title", group: "Role", sensitive: false, example: "Senior Software Engineer" },

  { token: "location.name", label: "Location Name", group: "Location", sensitive: false, example: "Mumbai Office" },
  { token: "location.address", label: "Location Address", group: "Location", sensitive: false, example: "BKC, Mumbai, Maharashtra" },

  { token: "company.name", label: "Company Name", group: "Company", sensitive: false, example: "StreamlineOS Pvt Ltd" },
  { token: "company.address", label: "Company Address", group: "Company", sensitive: false, example: "Tower B, BKC, Mumbai 400051" },
  { token: "company.website", label: "Company Website", group: "Company", sensitive: false, example: "https://streamlineos.app" },
  { token: "company.hrEmail", label: "HR Email", group: "Company", sensitive: false, example: "hr@streamlineos.app" },

  { token: "effectiveDate", label: "Effective Date", group: "General", sensitive: false, example: "1 May 2025" },
  { token: "today", label: "Today's Date", group: "General", sensitive: false, example: "11 July 2026" },

  { token: "salary.ctc", label: "CTC (Annual)", group: "Salary", sensitive: true, example: "₹12,00,000" },
  { token: "salary.basic", label: "Basic Salary (Monthly)", group: "Salary", sensitive: true, example: "₹50,000" },
  { token: "salary.grossMonthly", label: "Gross Monthly", group: "Salary", sensitive: true, example: "₹80,000" },
  { token: "salary.probationSalary", label: "Probation Salary", group: "Salary", sensitive: true, example: "₹60,000" },

  { token: "policy.noticePeriodDays", label: "Notice Period (Days)", group: "Policy", sensitive: false, example: "90" },
  { token: "policy.probationDays", label: "Probation Period (Days)", group: "Policy", sensitive: false, example: "180" },
  { token: "policy.workingHours", label: "Working Hours", group: "Policy", sensitive: false, example: "9 AM – 6 PM" },

  { token: "workflow.approverName", label: "Approver Name", group: "Workflow", sensitive: false, example: "Deepak Nair" },
  { token: "workflow.submittedOn", label: "Submitted On", group: "Workflow", sensitive: false, example: "10 July 2026" },
];
