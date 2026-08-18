import { functionBodyHashes } from "./bundle-function-hashes";

export type ColumnRequirement = {
  relation: string;
  name: string;
  dataType: string;
  notNull: boolean;
  defaultExpression: string | null;
  identity: "" | "a";
};

type ConstraintBase = {
  relation: string;
  name: string;
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
};

export type KeyConstraintRequirement = ConstraintBase & {
  kind: "primary" | "unique";
  columns: string[];
};

export type ForeignKeyRequirement = ConstraintBase & {
  kind: "foreign";
  columns: string[];
  referencedRelation: string;
  referencedColumns: string[];
  matchType: "f" | "s";
  updateAction: "a" | "c" | "d" | "n" | "r";
  deleteAction: "a" | "c" | "d" | "n" | "r";
};

export type CheckConstraintRequirement = ConstraintBase & {
  kind: "check";
  expression: string;
};

export type ExclusionConstraintRequirement = ConstraintBase & {
  kind: "exclude";
  elements: Array<{ expression: string; operator: string }>;
  predicate: string | null;
};

export type ConstraintDefinitionRequirement =
  | KeyConstraintRequirement
  | ForeignKeyRequirement
  | CheckConstraintRequirement
  | ExclusionConstraintRequirement;

export type IndexRequirement = {
  relation: string;
  name: string;
  unique: boolean;
  keys: string[];
  predicate: string | null;
};

export type FunctionRequirement = {
  name: string;
  argumentTypes: string[];
  resultType: string;
  language: "plpgsql" | "sql";
  securityDefiner: boolean;
  volatility: "i" | "v";
  strict: boolean;
  publicExecute: boolean;
  bodySha256: string[];
};

export type EnumRequirement = {
  name: string;
  labels: string[];
};

export type FileDefinitionRequirement = {
  columns: ColumnRequirement[];
  exactColumnRelations: string[];
  ownerOnlyRelations: string[];
  constraints: ConstraintDefinitionRequirement[];
  indexes: IndexRequirement[];
  functions: FunctionRequirement[];
  enums: EnumRequirement[];
};

export function column(
  relation: string,
  name: string,
  dataType: string,
  notNull = false,
  defaultExpression: string | null = null,
  identity: "" | "a" = "",
): ColumnRequirement {
  return {
    relation,
    name,
    dataType,
    notNull,
    defaultExpression,
    identity,
  };
}

export function key(
  relation: string,
  name: string,
  kind: "primary" | "unique",
  columns: string[],
): KeyConstraintRequirement {
  return {
    relation,
    name,
    kind,
    columns,
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
  };
}

export function check(
  relation: string,
  name: string,
  expression: string,
  validated = true,
): CheckConstraintRequirement {
  return {
    relation,
    name,
    kind: "check",
    expression,
    validated,
    deferrable: false,
    initiallyDeferred: false,
  };
}

export function foreignKey(
  relation: string,
  name: string,
  columns: string[],
  referencedRelation: string,
  referencedColumns: string[],
  options: {
    validated?: boolean;
    deferrable?: boolean;
    deleteAction?: ForeignKeyRequirement["deleteAction"];
    matchType?: ForeignKeyRequirement["matchType"];
  } = {},
): ForeignKeyRequirement {
  const deferrable = options.deferrable ?? false;
  return {
    relation,
    name,
    kind: "foreign",
    columns,
    referencedRelation,
    referencedColumns,
    validated: options.validated ?? true,
    deferrable,
    initiallyDeferred: deferrable,
    matchType: options.matchType ?? "s",
    updateAction: "a",
    deleteAction: options.deleteAction ?? "r",
  };
}

export function exclusion(
  relation: string,
  name: string,
  elements: Array<{ expression: string; operator: string }>,
  predicate: string | null = null,
): ExclusionConstraintRequirement {
  return {
    relation,
    name,
    kind: "exclude",
    elements,
    predicate,
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
  };
}

export function index(
  relation: string,
  name: string,
  keys: string[],
  unique = false,
  predicate: string | null = null,
): IndexRequirement {
  return { relation, name, unique, keys, predicate };
}

export function triggerFunction(
  name: string,
  securityDefiner = false,
  publicExecute = true,
): FunctionRequirement {
  const bodySha256 = functionBodyHashes(name);
  return {
    name,
    argumentTypes: [],
    resultType: "trigger",
    language: "plpgsql",
    securityDefiner,
    volatility: "v",
    strict: false,
    publicExecute,
    bodySha256,
  };
}
