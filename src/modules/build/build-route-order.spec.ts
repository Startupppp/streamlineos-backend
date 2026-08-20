import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

type Route = {
  method: string;
  segments: string[];
  controller: string;
  handler: string;
};

const BUILD_DIR = join(__dirname);
const HTTP_DECORATORS = new Set(["Get", "Post", "Patch", "Put", "Delete", "Head", "Options", "All"]);

function sourceFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, suffix));
    else if (entry.endsWith(suffix)) out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function decoratorCalls(node: ts.Node): ts.CallExpression[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decorators = ts.getDecorators(node) ?? [];
  return decorators.map((d) => d.expression).filter(ts.isCallExpression);
}

function decoratorName(call: ts.CallExpression): string {
  return ts.isIdentifier(call.expression) ? call.expression.text : "";
}

function firstStringArg(call: ts.CallExpression): string {
  const arg = call.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : "";
}

function normalize(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function collectControllerRoutes(): Map<string, Route[]> {
  const byClass = new Map<string, Route[]>();
  for (const file of sourceFiles(BUILD_DIR, ".controller.ts")) {
    const source = parse(file);
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      const controllerDecorator = decoratorCalls(node).find((c) => decoratorName(c) === "Controller");
      if (!controllerDecorator) return;
      const prefix = normalize(firstStringArg(controllerDecorator));
      const routes: Route[] = [];
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const httpDecorator = decoratorCalls(member).find((c) => HTTP_DECORATORS.has(decoratorName(c)));
        if (!httpDecorator) continue;
        routes.push({
          method: decoratorName(httpDecorator).toUpperCase(),
          segments: [...prefix, ...normalize(firstStringArg(httpDecorator))],
          controller: node.name.text,
          handler: member.name.getText(source),
        });
      }
      byClass.set(node.name.text, routes);
    });
  }
  return byClass;
}

function arrayIdentifiers(expression: ts.Expression, source: ts.SourceFile): string[] {
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.filter(ts.isIdentifier).map((e) => e.text);
  if (!ts.isIdentifier(expression)) return [];
  let resolved: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== expression.text) continue;
      if (declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer))
        resolved = declaration.initializer.elements.filter(ts.isIdentifier).map((e) => e.text);
    }
  });
  return resolved;
}

type ModuleDecl = { imports: string[]; controllers: string[] };

function collectModules(): Map<string, ModuleDecl> {
  const byClass = new Map<string, ModuleDecl>();
  for (const file of sourceFiles(BUILD_DIR, ".module.ts")) {
    const source = parse(file);
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      const moduleDecorator = decoratorCalls(node).find((c) => decoratorName(c) === "Module");
      if (!moduleDecorator) return;
      const arg = moduleDecorator.arguments[0];
      const decl: ModuleDecl = { imports: [], controllers: [] };
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const property of arg.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          if (property.name.text === "imports")
            decl.imports = arrayIdentifiers(property.initializer, source);
          if (property.name.text === "controllers")
            decl.controllers = arrayIdentifiers(property.initializer, source);
        }
      }
      byClass.set(node.name.text, decl);
    });
  }
  return byClass;
}

/**
 * Mirrors Nest's registration order: a module's imports are scanned before its
 * own controllers, so the flattened list is the order Express matches in.
 */
function flattenRoutes(
  moduleName: string,
  modules: Map<string, ModuleDecl>,
  controllers: Map<string, Route[]>,
  seen = new Set<string>(),
): Route[] {
  if (seen.has(moduleName)) return [];
  seen.add(moduleName);
  const decl = modules.get(moduleName);
  if (!decl) return [];
  const routes: Route[] = [];
  for (const imported of decl.imports)
    routes.push(...flattenRoutes(imported, modules, controllers, seen));
  for (const controller of decl.controllers) routes.push(...(controllers.get(controller) ?? []));
  return routes;
}

function resolve(routes: Route[], method: string, path: string): Route | undefined {
  const segments = normalize(path);
  return routes.find(
    (route) =>
      route.method === method &&
      route.segments.length === segments.length &&
      route.segments.every((segment, i) => segment.startsWith(":") || segment === segments[i]),
  );
}

describe("Build route registration order", () => {
  const routes = flattenRoutes("BuildModule", collectModules(), collectControllerRoutes());

  it("collects the Build route table from source", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it.each([
    ["/build/portfolios", "PortfoliosController"],
    ["/build/programs", "ProgramsController"],
    ["/build/managed-products", "ManagedProductsController"],
    ["/build/teams", "TeamsController"],
  ])("GET %s resolves to its own controller, not :projectId", (path, controller) => {
    expect(resolve(routes, "GET", path)?.controller).toBe(controller);
  });

  it("still resolves a numeric id to the project detail handler", () => {
    const route = resolve(routes, "GET", "/build/4");
    expect(route?.controller).toBe("ProjectsByIdController");
    expect(route?.handler).toBe("getProject");
  });

  it("registers no bare :param route ahead of a literal sibling under /build", () => {
    const shadowed: string[] = [];
    routes.forEach((route, index) => {
      if (route.segments.length !== 2 || route.segments[0] !== "build") return;
      if (!route.segments[1]?.startsWith(":")) return;
      for (const later of routes.slice(index + 1)) {
        if (later.method !== route.method) continue;
        if (later.segments.length !== 2 || later.segments[0] !== "build") continue;
        if (later.segments[1]?.startsWith(":")) continue;
        shadowed.push(`${route.method} /build/${later.segments[1]} (shadowed by ${route.controller})`);
      }
    });
    expect(shadowed).toEqual([]);
  });
});
