# MSight Cloud — Management Console

Vue 3 + Vite + TypeScript + Element Plus front end for the MSight cloud stack.

Authentication is Amazon Cognito. There is **no self-registration**: the master
account is seeded from `deploy.config.yaml` at deploy time, and every other
account is created by an admin from the Users tab.

## Access levels

Roles are Cognito groups. A user belongs to exactly one.

| Role | Can do |
| --- | --- |
| `admin` | Everything, including creating, disabling, and deleting users |
| `operator` | Operational actions; cannot manage users |
| `viewer` | Read-only |

The Users tab is hidden and route-guarded for anyone who is not an admin, and
the API enforces the same rule server-side — the guard is convenience, not the
security boundary.

## Setup

Deploy the stack first, then take three values from the `cdk deploy` outputs:

```
AdminUserPoolId       -> VITE_USER_POOL_ID
AdminUserPoolClientId -> VITE_USER_POOL_CLIENT_ID
AdminApiUrl           -> VITE_ADMIN_API_URL
```

```bash
cd admin-console
cp .env.example .env      # then fill in the three values above
npm install
npm run dev               # http://localhost:5173
```

Sign in with the `masterUsername` / `masterPassword` from `deploy.config.yaml`.

## CORS

The dev server runs on port 5173, which must appear in
`adminConsole.allowedOrigins` in `deploy.config.yaml`. It is the default. When
the console gets a hosted origin, add that origin there and redeploy.

## Adding a tab

1. Add the view under `src/views/`.
2. Register a child route in `src/router/index.ts` (set `meta.requiresAdmin` if
   it should be admin-only).
3. Add an entry to `navItems` in `src/layouts/AdminLayout.vue`.

New backend operations go in the router inside `src/functions/admin-api/handler.ts`
— the API Gateway route is a catch-all, so no CDK change is needed.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Type-check then build to `dist/` |
| `npm run typecheck` | `vue-tsc --noEmit` |
