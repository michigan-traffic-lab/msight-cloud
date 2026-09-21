# MSight Cloud admin console

A Vue 3 + Quasar single-page app. `npm run deploy` at the repository root
builds it, uploads it to S3 and invalidates CloudFront as part of every
deploy — this directory is not deployed on its own, and needs no setup of its
own to be deployed.

What follows is for working on the UI.

## Install

```bash
npm install
```

Separate from the repository root's install: the console is its own package
rather than a workspace. From the root you can do both at once:

```bash
npm install && npm install --prefix admin-console
```

## Running it locally

`quasar dev` serves the console from your machine against a real deployment's
API and Cognito pool — you are signing in as a real user against real data,
not a mock.

```bash
npx quasar dev
```

It reads four values from `.env`:

| Variable | From the stack output |
| --- | --- |
| `VITE_AWS_REGION` | the region you deployed to |
| `VITE_USER_POOL_ID` | `AdminUserPoolId` |
| `VITE_USER_POOL_CLIENT_ID` | `AdminUserPoolClientId` |
| `VITE_ADMIN_API_URL` | `AdminApiUrl` |

**You do not normally create that file.** `npm run deploy` writes it from the
stack's own CloudFormation outputs on every deploy and overwrites whatever is
there, so if you have deployed from this checkout it already exists and is
already correct.

Write it yourself only for a checkout that has never deployed — a fresh clone
pointed at a stack someone else deployed:

```bash
cp .env.example .env
aws cloudformation describe-stacks --stack-name MsightCloudStack \
  --query "Stacks[0].Outputs[?OutputKey=='AdminApiUrl'||OutputKey=='AdminUserPoolId'||OutputKey=='AdminUserPoolClientId'].[OutputKey,OutputValue]" \
  --output text
```

All four are required. `src/config.ts` refuses to start without them rather
than falling back to a default, because a console pointed at the wrong
account is worse than one that will not load.

## Building

```bash
npm run build
```

Produces `dist/spa` and nothing else — it uploads nothing. To put a change in
front of anyone, run `npm run deploy` from the repository root. Running
`npx cdk deploy` alone deploys the infrastructure and leaves the previously
uploaded console in place, which is how a backend change and a console change
end up disagreeing.

## Type-checking

```bash
npm run typecheck
```

The console's pure TypeScript modules — log filtering, AWS console links —
are covered by the repository-root Jest suite (`npm test` there), not by a
runner in here.

## Customize the configuration

See [Configuring quasar.config.js](https://v2.quasar.dev/quasar-cli-vite/quasar-config-file).
