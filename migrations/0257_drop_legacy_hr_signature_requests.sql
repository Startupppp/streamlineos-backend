-- The basic internal-only "HR digital signatures" feature (signature_requests) is fully
-- superseded by SignOS (real e-signature: external signers, PDF stamping, watermarks,
-- certificates, audit trail). No service references this table anymore.
DROP TABLE IF EXISTS signature_requests;
