import { generateResignationLetter } from "./letters";

describe("generateResignationLetter", () => {
  it("renders employee-written fields as text, never markup", () => {
    const html = generateResignationLetter({
      employeeName: "<img src=x onerror=alert(1)>",
      designation: "Engineer",
      department: null,
      joiningDate: "2024-01-01",
      date: "2026-09-30",
      reason: '<form action="https://evil"><input name="pw"><button>Confirm</button></form>',
      reasonCategory: "Personal",
      lastWorkingDate: "2026-10-30",
      companyName: "Acme",
    });
    expect(html).not.toMatch(/<form|<img|<input/);
    expect(html).toContain("&lt;form action=&quot;https://evil&quot;&gt;");
  });
});
