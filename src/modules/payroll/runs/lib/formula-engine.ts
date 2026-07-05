import { FORMULA_VARIABLES } from "../../payroll.types";
import type { FormulaScope } from "../../payroll.types";

export interface FormulaError {
  ok: false;
  error: string;
}

export interface FormulaSuccess {
  ok: true;
  value: number;
}

export type FormulaResult = FormulaSuccess | FormulaError;

const VALID_VARS = new Set<string>(FORMULA_VARIABLES);

interface Token {
  type: "NUMBER" | "IDENT" | "OP" | "LPAREN" | "RPAREN" | "COMMA" | "EOF";
  value: string;
}

function tokenize(formula: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (ch >= "0" && ch <= "9" || ch === ".") {
      let num = "";
      while (i < formula.length && (formula[i]! >= "0" && formula[i]! <= "9" || formula[i] === ".")) {
        num += formula[i++];
      }
      tokens.push({ type: "NUMBER", value: num });
      continue;
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      let ident = "";
      while (i < formula.length && ((formula[i]! >= "a" && formula[i]! <= "z") || (formula[i]! >= "A" && formula[i]! <= "Z") || formula[i] === "_" || (formula[i]! >= "0" && formula[i]! <= "9"))) {
        ident += formula[i++];
      }
      tokens.push({ type: "IDENT", value: ident });
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ type: "OP", value: ch });
      i++;
      continue;
    }
    if (ch === "(") { tokens.push({ type: "LPAREN", value: "(" }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "RPAREN", value: ")" }); i++; continue; }
    if (ch === ",") { tokens.push({ type: "COMMA", value: "," }); i++; continue; }
    return `Unexpected character: ${ch}`;
  }
  tokens.push({ type: "EOF", value: "" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: FormulaScope,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "EOF", value: "" };
  }

  private consume(): Token {
    const t = this.tokens[this.pos] ?? { type: "EOF", value: "" };
    this.pos++;
    return t;
  }

  parseExpr(): FormulaResult {
    let left = this.parseTerm();
    if (!left.ok) return left;
    while (this.peek().type === "OP" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.consume().value;
      const right = this.parseTerm();
      if (!right.ok) return right;
      const val: number = op === "+" ? left.value + right.value : left.value - right.value;
      if (!isFinite(val)) return { ok: false, error: "Arithmetic overflow" };
      left = { ok: true, value: val };
    }
    return left;
  }

  private parseTerm(): FormulaResult {
    let left = this.parseFactor();
    if (!left.ok) return left;
    while (this.peek().type === "OP" && (this.peek().value === "*" || this.peek().value === "/")) {
      const op = this.consume().value;
      const right = this.parseFactor();
      if (!right.ok) return right;
      if (op === "/" && right.value === 0) return { ok: false, error: "Division by zero" };
      const val: number = op === "*" ? left.value * right.value : left.value / right.value;
      if (!isFinite(val) || isNaN(val)) return { ok: false, error: "Division by zero" };
      left = { ok: true, value: val };
    }
    return left;
  }

  private parseFactor(): FormulaResult {
    const t = this.peek();
    if (t.type === "OP" && (t.value === "-" || t.value === "+")) {
      this.consume();
      const operand = this.parseFactor();
      if (!operand.ok) return operand;
      return { ok: true, value: t.value === "-" ? -operand.value : operand.value };
    }
    if (t.type === "LPAREN") {
      this.consume();
      const inner = this.parseExpr();
      if (!inner.ok) return inner;
      if (this.peek().type !== "RPAREN") return { ok: false, error: "Syntax error: expected )" };
      this.consume();
      return inner;
    }
    if (t.type === "NUMBER") {
      this.consume();
      const val = parseFloat(t.value);
      if (isNaN(val)) return { ok: false, error: `Syntax error: invalid number ${t.value}` };
      return { ok: true, value: val };
    }
    if (t.type === "IDENT") {
      this.consume();
      const name = t.value;
      if (name === "min" || name === "max" || name === "round") {
        return this.parseFunc(name);
      }
      if (!VALID_VARS.has(name)) return { ok: false, error: `Unknown variable: ${name}` };
      return { ok: true, value: this.scope[name as keyof FormulaScope] };
    }
    if (t.type === "EOF") return { ok: false, error: "Syntax error: unexpected end of formula" };
    return { ok: false, error: `Syntax error: unexpected token ${t.value}` };
  }

  private parseFunc(name: string): FormulaResult {
    if (this.peek().type !== "LPAREN") return { ok: false, error: `Syntax error: expected ( after ${name}` };
    this.consume();
    const args: FormulaResult[] = [];
    if (this.peek().type !== "RPAREN") {
      const first = this.parseExpr();
      if (!first.ok) return first;
      args.push(first);
      while (this.peek().type === "COMMA") {
        this.consume();
        const arg = this.parseExpr();
        if (!arg.ok) return arg;
        args.push(arg);
      }
    }
    if (this.peek().type !== "RPAREN") return { ok: false, error: "Syntax error: expected ) after function args" };
    this.consume();

    if (name === "min") {
      if (args.length < 2) return { ok: false, error: "min() requires at least 2 arguments" };
      return { ok: true, value: Math.min(...args.map(a => (a as FormulaSuccess).value)) };
    }
    if (name === "max") {
      if (args.length < 2) return { ok: false, error: "max() requires at least 2 arguments" };
      return { ok: true, value: Math.max(...args.map(a => (a as FormulaSuccess).value)) };
    }
    if (name === "round") {
      if (args.length < 1) return { ok: false, error: "round() requires at least 1 argument" };
      const x = (args[0] as FormulaSuccess).value;
      const n = args.length >= 2 ? Math.round((args[1] as FormulaSuccess).value) : 0;
      const factor = Math.pow(10, n);
      return { ok: true, value: Math.round(x * factor) / factor };
    }
    return { ok: false, error: `Unknown function: ${name}` };
  }
}

export function evalFormula(formula: string, scope: FormulaScope): FormulaResult {
  const trimmed = formula.trim();
  if (!trimmed) return { ok: false, error: "Syntax error: empty formula" };

  const tokens = tokenize(trimmed);
  if (typeof tokens === "string") return { ok: false, error: tokens };

  const parser = new Parser(tokens, scope);
  const result = parser.parseExpr();
  if (!result.ok) return result;

  const last = tokens[parser["pos"]];
  if (last && last.type !== "EOF") {
    return { ok: false, error: `Syntax error: unexpected token after expression: ${last.value}` };
  }

  if (isNaN(result.value) || !isFinite(result.value)) {
    return { ok: false, error: "Result is not a finite number" };
  }

  return result;
}
