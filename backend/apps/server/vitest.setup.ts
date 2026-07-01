// Vitest global setup — must run before any project imports evaluate
// `config.ts`, which validates required env vars at module load.
process.env.DATABASE_URL     ??= "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore-abcdefghij";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";
process.env.NODE_ENV         ??= "test";
