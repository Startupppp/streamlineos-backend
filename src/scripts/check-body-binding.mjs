#!/usr/bin/env node
/**
 * check-body-binding — every route that validates with a Zod schema must type
 * its `@Body()` / `@Query()` parameter FROM that schema.
 *
 * WHY THIS IS A GATE. `@Validate({ body: resendVerificationSchema })` beside a
 * hand-written `@Body() body: { email: string }` declares the same shape twice
 * and links the two declarations not at all. Nothing arbitrates them: the zod
 * schema can gain, lose or retype a field and the parameter type will not move,
 * exactly the way `apiClient.get<T>` casts rather than validates on the client.
 *
 * It also blinds every field-level instrument. A property read off an unlinked
 * parameter resolves to the inline literal, never to the schema's own
 * PropertyAssignment, so the checker records zero reads of a field the handler
 * reads on every request — and deleting that field does not break the build.
 * 35 such routes held ticket 08 box 4 open across two passes because no
 * instrument could see a read on any of them.
 *
 * A slot is BOUND when at least one property of the parameter's type declares
 * into the validating schema's own `z.object({...})` literal, resolved through
 * the type checker, so `z.infer<typeof s>`, `type X = z.infer<typeof s>` and
 * `Pick<X, …>` all count while a same-shaped hand-written type does not.
 *
 * A union schema infers to a union type, and `getPropertiesOfType` on a union
 * yields only the properties common to EVERY constituent — zero for disjoint
 * shapes — so the constituents are walked individually. A schema with no
 * resolvable object properties at all (`z.record`, an empty `z.object`) can
 * never produce a hit; that is a property of the schema, not of the route, and
 * is reported as NO-FIELDS rather than failed.
 */
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SLOT_DECORATOR = { body: "Body", query: "Query" };

const cfg = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(ROOT, "tsconfig.build.json"), ts.sys.readFile).config,
  ts.sys,
  ROOT,
);
const program = ts.createProgram(cfg.fileNames, { ...cfg.options, skipLibCheck: true, noEmit: true });
const checker = program.getTypeChecker();

const declKeysOf = (type, into) => {
  if (!type) return;
  if (type.isUnionOrIntersection && type.isUnionOrIntersection()) {
    for (const c of type.types) declKeysOf(c, into);
    return;
  }
  for (const p of checker.getPropertiesOfType(type))
    for (const d of p.declarations || [])
      into.add(`${d.getSourceFile().fileName}:${d.getStart()}`);
};

const unbound = [];
let slots = 0;
let bound = 0;
let noFields = 0;
let noParam = 0;

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
  if (!/\.controller\.ts$/.test(sf.fileName)) continue;

  const visit = (node) => {
    if (ts.isMethodDeclaration(node)) {
      let validate = null;
      for (const d of ts.getDecorators(node) || []) {
        if (!ts.isCallExpression(d.expression)) continue;
        const callee = d.expression.expression;
        if (!ts.isIdentifier(callee) || callee.text !== "Validate") continue;
        const arg = d.expression.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
        validate = {};
        for (const p of arg.properties)
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) validate[p.name.text] = p.initializer;
      }
      if (validate) {
        for (const slot of ["body", "query"]) {
          const schemaExpr = validate[slot];
          if (!schemaExpr) continue;
          slots++;

          const schemaType = checker.getTypeAtLocation(schemaExpr);
          const outSym = schemaType && schemaType.getProperty("_output");
          const outType = outSym ? checker.getTypeOfSymbolAtLocation(outSym, schemaExpr) : null;
          const schemaDeclKeys = new Set();
          declKeysOf(outType, schemaDeclKeys);

          let param = null;
          for (const pr of node.parameters)
            for (const d of ts.getDecorators(pr) || []) {
              if (!ts.isCallExpression(d.expression)) continue;
              const callee = d.expression.expression;
              if (ts.isIdentifier(callee) && callee.text === SLOT_DECORATOR[slot] && d.expression.arguments.length === 0)
                param = pr;
            }
          if (!param) {
            noParam++;
            continue;
          }
          if (schemaDeclKeys.size === 0) {
            noFields++;
            continue;
          }
          const paramKeys = new Set();
          declKeysOf(checker.getTypeAtLocation(param), paramKeys);
          if ([...paramKeys].some((k) => schemaDeclKeys.has(k))) {
            bound++;
            continue;
          }
          unbound.push({
            file: relative(ROOT, sf.fileName),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            method: node.name.getText(sf),
            slot,
            schema: schemaExpr.getText(sf).slice(0, 60),
            paramType: checker.typeToString(checker.getTypeAtLocation(param)).slice(0, 100),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

console.log(`check-body-binding: ${slots} validated body/query slots on controller routes`);
console.log(`  BOUND      ${bound}`);
console.log(`  NO-FIELDS  ${noFields}  (z.record / empty z.object — no property to bind)`);
console.log(`  no-param   ${noParam}  (handler declares no @Body()/@Query() parameter)`);
console.log(`  UNBOUND    ${unbound.length}`);

if (unbound.length > 0) {
  console.error("\nEach route below declares its shape twice and links the two not at all.");
  console.error("Type the parameter as z.infer<typeof theSchemaThatValidatesIt>.\n");
  for (const r of unbound)
    console.error(`  ${r.file}:${r.line} ${r.method} (${r.slot}) @Validate ${r.schema} vs ${r.paramType}`);
  process.exit(1);
}
console.log("check-body-binding: every validated slot is typed from its own schema.");
