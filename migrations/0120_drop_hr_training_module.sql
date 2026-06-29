-- Remove HR Training programs feature (tables + enums only used by that module)
DROP TABLE IF EXISTS "training_enrollments" CASCADE;
DROP TABLE IF EXISTS "training_programs" CASCADE;
DROP TYPE IF EXISTS "training_status";
DROP TYPE IF EXISTS "enrollment_status";
