# Release Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Require pull-request releases and identify/verify the version running in production.

**Architecture:** Add a public React Router resource route, a build commit binding and Cloudflare version metadata binding, and a bounded post-deploy verifier called by GitHub Actions.

**Tech Stack:** Existing React Router, Cloudflare `cf`, TypeScript, Vitest, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-28-release-heartbeat-design.md`

## Constraints and review focus

- Release through a pull request and CI/CD; direct deployment only as a documented fallback.
- Keep heartbeat public and uncached, with no account or database data.
- Match the deployed commit exactly; reject an old release, invalid metadata, redirects, and non-200 responses.
- Retry propagation delays for a bounded period; do not verify a deployment that the main-revision guard skipped.
- Preserve existing uncommitted shared-wishlist work in the PR and leave unrelated local files out.

### Task 1: Instructions and heartbeat

- [x] Create `.github/copilot-instructions.md` with the requested release policy and fallback.
- [x] Commit the previously verified shared-wishlist changes separately to preserve their source for CI/CD.
- [x] Add HTTP tests for public JSON release metadata, no-store headers, and HEAD; observe the missing endpoint fail.
- [x] Add `app/routes/heartbeat.ts`, register it in `app/routes.ts`, add typed release bindings in `app/env.ts`, and configure `BUILD_COMMIT` / `WORKER_VERSION` in `cloudflare.config.ts`.
- [x] Run the heartbeat HTTP tests in both mobile projects.

### Task 2: Release verification and documentation

- [x] Add tests for valid metadata, wrong commit, malformed/error responses, and bounded retry success/failure; observe failures before implementation.
- [x] Implement `scripts/verify-deployment.ts` with a five-second request timeout and at most twelve attempts, five seconds apart. Export the verifier for controlled local HTTP tests.
- [x] Pass `SANTA_BUILD_COMMIT` into the CI production build and verify the live heartbeat after a successful current-revision deployment.
- [x] Update README/contributor guidance and manual fallback commands.
- [x] Run TypeScript, Vitest, relevant browser checks, and the Worker build; request one independent read-only review and resolve material findings.

Local verification: 103 Vitest tests passed; public GET/HEAD heartbeat checks passed in both mobile projects; TypeScript and the Worker/client build passed. Independent review findings were reproduced and resolved. The CI test server pins a synthetic release SHA so exported fallback-release settings cannot change test expectations.

### Task 3: Pull request

- [ ] Commit the heartbeat/policy changes and push the feature branch.
- [ ] Open a pull request including the shared-wishlist source and release verification changes.
- [ ] Follow CI checks to completion and report the PR and exact release behavior. Do not deploy directly while the normal release path is available.
