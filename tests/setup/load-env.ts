/**
 * Vitest setup: load .env.local (if present) so integration tests that need real
 * backend credentials can read them from process.env. Absent file → those tests
 * simply skip (see webdav-backend.spec.ts). Never committed; .env.local is
 * git-ignored.
 */
try {
  // Node ≥ 20.12 exposes process.loadEnvFile.
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(".env.local");
} catch {
  /* .env.local not found — integration tests will be skipped */
}
