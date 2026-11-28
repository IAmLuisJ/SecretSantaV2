# Repository instructions

## Changes and releases

- Make changes on a feature branch and open a pull request against `main`. Do not push changes directly to `main`.
- Include the implementation, meaningful tests, migrations, and relevant documentation in the same pull request. Keep credentials, local data, and unrelated changes out of commits.
- Run the required checks and wait for the pull request's CI checks to pass before merging. Fix failing checks rather than bypassing them.
- Let the GitHub Actions CI/CD pipeline apply pending D1 migrations and deploy the production Worker after the pull request merges. Direct deployment is a fallback, not the normal release process.
- After release, check the public `/heartbeat` endpoint. Its `commit` must match the commit released by CI/CD; record its Cloudflare `version` when reporting a deployment.

## Direct deployment fallback

Direct deployment is allowed when the CI/CD release fails or is unavailable. Investigate and record why the pipeline could not release, keep the source changes in a pull request, and run the required checks locally before proceeding.

Build from a committed revision, set `SANTA_BUILD_COMMIT` to that exact commit, and use the existing production configuration and secrets. Validate the production build, apply only pending ordered migrations, and deploy the matching build. Verify `/heartbeat` reports the intended commit and a Cloudflare version, then report the deployment and the reason for the fallback.

## Project checks

- `npm run typecheck`
- `npm test`
- `npm run build`
- Both email and password modes of `npm run test:e2e` for affected user flows.

Use the existing Cloudflare `cf` CLI and `cloudflare.config.ts`. Follow `README.md` and `CONTRIBUTING.md` for setup, migration, and release details.
