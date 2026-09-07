import ts from "typescript";
import { readFileSync } from "node:fs";

const isConstAssertion = (t) =>
  ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.escapedText === "const";

for (const f of process.argv.slice(2)) {
  const source = readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isAsExpression(node)) {
      if (isConstAssertion(node.type)) {
        /* skip */
      } else if (node.type.kind === ts.SyntaxKind.UnknownKeyword && node.parent && ts.isAsExpression(node.parent)) {
        /* skip: inner half of as unknown as */
      } else if (ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
        /* skip: outer half of as unknown as */
      } else {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        console.log(`${f}:${line + 1}: as-cast: ${node.getText(sf)}`);
      }
    } else if (ts.isNonNullExpression(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      console.log(`${f}:${line + 1}: nonnull: ${node.getText(sf)}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}
