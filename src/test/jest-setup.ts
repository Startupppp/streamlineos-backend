process.env.APP_URL = process.env.APP_URL ?? "https://test.streamlineos.local";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS ?? "support@streamlineos.in";
process.env.EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME ?? "StreamlineOS";
// The schema makes this required to boot, so a test environment without one is not realistic.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "test-encryption-key-at-least-32-chars-long";
