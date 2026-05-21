# Live Convex e2e tests

These tests (`reconnect`, `restart`, `multiclient`) drive the embedded client
against a **real** Convex backend to exercise sync, reconnect, and offline
replay. They're skipped unless both `CONVEX_URL` and `RUN_CONVEX_E2E=1` are set
(see the gate at the top of each `*.test.ts`).

## Recommended: run against an ephemeral preview deployment

`pnpm test:live` deploys the `convex/` functions to an isolated, throwaway
**Convex preview deployment** named `embedded-e2e`, then runs the suite with
`CONVEX_URL` pointed at that preview:

```
vp exec convex deploy --preview-create=embedded-e2e \
  --cmd-url-env-var-name CONVEX_URL \
  --cmd 'RUN_CONVEX_E2E=1 vp test --run tests/e2e/convex'
```

The preview is **wiped and recreated** on every run, so each run starts from
empty tables. Tests namespace their own data (`uniqueSuffix(...)`), so no
seeding step is needed.

### One-time setup: a Preview Deploy Key

Preview deploys require `CONVEX_DEPLOY_KEY` to hold a **Preview Deploy Key**
(not a production key):

1. Convex dashboard → your project → Settings → Deploy Keys.
2. Generate a **Preview Deploy Key**.
3. Export it before running:

   ```
   export CONVEX_DEPLOY_KEY='<preview deploy key>'
   pnpm test:live
   ```

Without it, the `convex deploy` step fails fast with an auth error.

## Escape hatch: run against an existing deployment

If you already have a deployment (your own dev deployment, say) and just want to
point the suite at it:

```
CONVEX_URL='https://<your-deployment>.convex.cloud' pnpm test:live:url
```

This skips the preview deploy and runs directly against `CONVEX_URL`. Note that
test data accumulates on that deployment across runs.

## CI

`.github/workflows/e2e-live.yml` runs `pnpm test:live` on pull requests and
pushes to `main`. It needs a `CONVEX_DEPLOY_KEY` repo secret set to a Preview
Deploy Key. A workflow-level `concurrency` group serializes runs so overlapping
PRs don't clobber the shared `embedded-e2e` preview mid-test.

## Caveats

- **Fresh preview = empty tables.** Expected; tests seed their own data.
- **Agent tests would need an extra env var.** The current suite does not touch
  `convex/agent.ts`. If you add e2e coverage for the assistant, set its key on
  the preview first:

  ```
  vp exec convex env set OPENROUTER_API_KEY '<key>' --preview-name embedded-e2e
  ```
