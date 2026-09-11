import {
  IMPORT_ENTITIES,
  type AnchorRule,
  type EntityVocabulary,
  type ImportEntity,
  type ImportField,
  type MatchStrategy,
} from "./import-fields";
import { VOCABULARY } from "./import-vocabulary";

export * from "./import-fields";

/**
 * Which entity a file is for, and what its columns can mean.
 *
 * The importer used to be party-shaped all the way down: one flat field list,
 * one synonym table, one writer. Subjects, pipelines and activities are not a
 * second importer — they are the same plan, preview, durable commit and undo
 * with the vocabulary as a parameter. This file is how that parameter is asked:
 * the table it reads is `import-vocabulary.ts`, and every other module goes
 * through the accessors below rather than indexing the table itself.
 *
 * Everything here is pure and testable without a database, which is deliberate:
 * "what does this column mean" is the question the whole ticket turns on, and a
 * wrong answer writes wrong data into every row of somebody's file.
 */

// ── What the rest of the module asks the registry ──────────────────────────

export function vocabularyOf(entity: ImportEntity): EntityVocabulary {
  return VOCABULARY[entity];
}

export function fieldsFor(entity: ImportEntity): readonly ImportField[] {
  return VOCABULARY[entity].fields;
}

export function synonymsFor(entity: ImportEntity, field: ImportField): readonly string[] {
  return VOCABULARY[entity].synonyms[field] ?? [];
}

export function groupOf(entity: ImportEntity): string | undefined {
  return VOCABULARY[entity].group;
}

export function requiredFieldOf(entity: ImportEntity): { field: ImportField; reason: string } {
  return VOCABULARY[entity].required;
}

export function coerceFor(entity: ImportEntity): (field: ImportField, cell: string) => string | null {
  return (field, cell) => VOCABULARY[entity].coerce(field, cell);
}

export function matchStrategyFor(entity: ImportEntity): MatchStrategy {
  return VOCABULARY[entity].match;
}

export function anchorOf(entity: ImportEntity): AnchorRule | undefined {
  return VOCABULARY[entity].anchor;
}

export function isFieldOf(entity: ImportEntity, value: string): value is ImportField {
  return (VOCABULARY[entity].fields as readonly string[]).includes(value);
}

/**
 * Every field any entity has, which is what an override may legally name.
 *
 * The DTO validates against this and `applyOverrides` narrows against the
 * entity's own list, so naming a real field that belongs to a different entity
 * is refused with a sentence rather than accepted and dropped.
 */
export const ALL_IMPORT_FIELDS: readonly ImportField[] = [
  ...new Set<ImportField>(IMPORT_ENTITIES.flatMap((entity) => [...VOCABULARY[entity].fields])),
];

/**
 * The fields that decide WHICH party a row is, rather than what it says.
 *
 * Party-only, and that is the point: these are the keys the duplicate scorer
 * blocks and matches on, so a value belonging to somebody else landing in one
 * does not produce a slightly wrong record but the wrong record. The mapping
 * evals gate on exactly this set.
 */
export const IDENTITY_FIELDS: readonly ImportField[] = [
  "name",
  "legalName",
  "email",
  "phone",
  "taxNumber",
  "website",
];
