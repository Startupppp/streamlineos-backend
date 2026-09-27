import { mergeLetterTemplate } from "./letter-merge";

describe("mergeLetterTemplate", () => {
  it("fills employee and company tokens and drops optional blanks", () => {
    const html = mergeLetterTemplate(
      "Dear {{employee.firstName}}, {{employee.fullName}} joins {{company.name}} as {{role.title}} on {{today}}. Manager: {{manager.fullName}}. Dept: {{department.name}}. {{custom.note}}",
      {
        "employee.firstName": "John",
        "employee.fullName": "John Doe",
        "company.name": "QA HRMS Org",
        "role.title": "",
        today: "27 September 2026",
        "manager.fullName": "",
        "department.name": "",
      },
    );
    expect(html).toContain("Dear John, John Doe joins QA HRMS Org");
    expect(html).toContain("27 September 2026");
    expect(html).not.toContain("{{role.title}}");
    expect(html).not.toContain("{{manager.fullName}}");
    expect(html).toContain("{{custom.note}}");
  });
});
