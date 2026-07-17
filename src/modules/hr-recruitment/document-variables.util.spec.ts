import { substituteVariables } from "./document-variables.util";

describe("substituteVariables", () => {
  it("substitutes known variables", () => {
    const { result, missing } = substituteVariables("<p>Hello {{name}}</p>", { name: "Ada" });
    expect(result).toBe("<p>Hello Ada</p>");
    expect(missing).toEqual([]);
  });

  it("reports missing variables and leaves the token in place", () => {
    const { result, missing } = substituteVariables("<p>Hi {{name}}</p>", {});
    expect(missing).toEqual(["name"]);
    expect(result).toContain("{{name}}");
  });

  it("strips a script tag embedded in the template body", () => {
    const { result } = substituteVariables("<p>Hi {{name}}</p><script>alert(1)</script>", { name: "Ada" });
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("alert(1)");
  });

  it("strips an onerror handler embedded in the template body", () => {
    const { result } = substituteVariables('<img src=x onerror="alert(1)">', {});
    expect(result).not.toContain("onerror");
  });

  it("escapes a malicious variable value instead of letting it inject markup", () => {
    const { result } = substituteVariables("<p>Hi {{name}}</p>", {
      name: "<script>alert(1)</script>",
    });
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });
});
