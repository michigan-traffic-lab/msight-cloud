# MSight Cloud

MSight Cloud is a serverless AWS platform for ingesting, decoding, and
distributing connected-infrastructure and connected-vehicle data in real
time — sensor detections (SDSM), traffic signal state (SPaT), and
intersection geometry (MAP) — to nearby clients over WebSocket and HTTP.
It ships with a management console, a versioned public HTTP API for client
applications and integrators, and an MCP server so an AI assistant can
operate a deployment through natural language.

The entire stack — networking, compute, storage, and the API surface — is
defined as AWS CDK (TypeScript) and deploys into your own AWS account.

## Table of contents

- [Overview](#overview)
- [Domain glossary](#domain-glossary)
- [Architecture](#architecture)
- [API surface](#api-surface)
  - [Public client API](#public-client-api)
  - [Sensor and SPaT ingestion](#sensor-and-spat-ingestion)
  - [WebSocket API](#websocket-api)
  - [Admin API](#admin-api-cognito-protected)
  - [MCP server](#mcp-server)
  - [GitHub integration](#github-integration)
- [API documentation](#api-documentation)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Admin console](#admin-console)
- [Development](#development)
- [Tech stack](#tech-stack)
- [Security notes](#security-notes)
- [License](#license)

## Overview

A typical deployment sits behind a set of roadside sensors (e.g. LiDAR units
processed by an edge device) and traffic signal controllers. MSight Cloud:

- Ingests each sensor's message stream, decodes it, and fans it out to
  whichever connected client apps are physically nearby.
- Ingests each intersection's SPaT (signal phase and timing) stream and
  broadcasts it the same way, with a separate low-latency path for
  safety-critical changes.
- Tracks connected client apps' live locations so it knows who is "nearby"
  for any given broadcast.
- Serves a small, versioned public HTTP API that client applications use
  directly — location updates, latency probing, radius broadcast, and
  intersection map lookup.
- Gives operators a web console to manage sensors, inspect live clients,
  deploy their own supporting microservices from a GitHub repository, watch
  cost and health, and administer users.
- Gives an AI assistant (Claude, or anything else speaking MCP) the same
  operational capabilities as the console, over a long-lived token instead
  of a browser session.

## Domain glossary

MSight speaks a few V2X (vehicle-to-everything) terms that are useful to
know before reading the API surface below:

| Term | Meaning |
| --- | --- |
| **SDSM** | Sensor Data Sharing Message — a standardized description of objects (vehicles, pedestrians, etc.) detected by a roadside sensor. |
| **SPaT** | Signal Phase and Timing — a traffic signal's current phase (red/yellow/green per movement) and time remaining. |
| **MAP** | A J2735 MAP message: the lane-level geometry of an intersection, used to interpret SPaT and SDSM in context. |
| **RSU** | Roadside Unit — the field hardware a sensor or signal controller runs behind. |

## Architecture

```
Field sensors ──publish──▶ SNS (fan-out) ──▶ per-sensor SQS FIFO queue ──▶ dedicated ECS Fargate task
                                                                              │
Signal controllers ──▶ SNS (SPaT topic) ──▶ Lambda consumers (2 Hz + critical)│
                                                                              ▼
                                                          decode → look up intersection in Aurora
                                                          → find nearby clients in Valkey (geo index)
                                                          → push over WebSocket
                                                                              ▲
Client apps ──HTTP (location, latency, maps)──▶ API Gateway (HTTP API) ──────┘
Client apps ◀──WebSocket (live pushes)──▶ API Gateway (WebSocket API)

Operators ──HTTPS──▶ Admin console (S3 + CloudFront, Vue/Quasar)
                          │  Cognito-authenticated
                          ▼
                   Admin API (API Gateway) ──▶ two Lambdas: in-VPC (Aurora/Valkey) and out-of-VPC (AWS APIs)

AI assistants ──HTTP (MCP, token-authenticated)──▶ MCP server ──▶ same two admin Lambdas, invoked directly
```

Core data stores:

- **Aurora PostgreSQL + PostGIS** — intersection maps, sensor and app
  registries, MCP tokens, and anything else that must survive a restart.
- **Valkey (ElastiCache)** — live client locations (geo-indexed, TTL'd),
  WebSocket connection lookups, and per-sensor config caches.
- **S3** — aggregated sensor data uploads and the admin console's static
  build.

Every sensor gets its own SQS FIFO queue and its own long-running ECS
Fargate task rather than a shared Lambda pool — this keeps warm connections
to Valkey and Aurora, caches per-sensor config in memory, and guarantees
ordered processing within that sensor's stream. Sensor infrastructure
(queues, subscriptions, ECS services) is created and torn down at runtime by
the admin API as sensors are registered, not by CloudFormation.

## API surface

This section describes each API at the level of "what is it for" — full
request/response detail lives in the generated OpenAPI document (see
[API documentation](#api-documentation)), and the console's MCP page lists
every MCP tool with its own description.

### Public client API

Unauthenticated, CORS-open, meant for client applications (in-vehicle apps,
roadside displays, integrators) to call directly. This is the surface the
OpenAPI document covers.

| Route | Purpose |
| --- | --- |
| `POST /v1/clients/location/update` | A client reports its current location, stored with a short TTL so it can be found in radius queries. |
| `GET /v1/clients/location/health` | Health check for the location service. |
| `GET /v1/client/latency` | Round-trip latency probe; also reports server-side Valkey and PostgreSQL latency. |
| `POST /v1/clients/notify/radius` | Broadcasts a message to every WebSocket-connected client within a radius of a point. Used internally by the SPaT and sensor pipelines, and exposed for direct use. |
| `GET /v1/clients/notify/radius/health` | Health check for radius broadcast. |
| `GET /v1/maps/search` | Finds intersection maps within a radius of a lat/lon point. |
| `GET /v1/maps/{name}` | Fetches one intersection map by name. |
| `GET /system/health` | Service health check. |
| `GET /system/version` | Deployed build identifier and API version. |
| `GET /system/websocket-url` | Tells a client which WebSocket endpoint to connect to. |
| `GET /system/openapi.json` | This API's OpenAPI 3.0 document, generated live from the same schemas that validate requests. |
| `GET /system/docs` | The same document rendered as browsable Swagger UI. |

### Sensor and SPaT ingestion

Sensors do not call an HTTP endpoint to ingest data — they publish directly
to an SNS topic, from which a per-sensor SQS FIFO queue and a dedicated ECS
task decode, cache, and broadcast each message (see
[Architecture](#architecture)). SPaT messages take a parallel path through
their own SNS topic to two Lambda consumers: one rate-limited to 2 Hz for
routine updates, and one intended to pass through only safety-significant
changes for lower-latency delivery. Onboarding a sensor (provisioning its
queue, subscription, and ECS service) is done from the admin console or MCP,
not by calling an API directly.

### WebSocket API

`$connect` / `$disconnect` routes register and clean up a client's
connection record in Valkey, keyed by the app and client IDs it connects
with. Once connected, a client receives pushes from the radius broadcast and
SPaT pipelines — there is no client-initiated message type; every payload is
server-pushed.

### Admin API (Cognito-protected)

Backs the [admin console](#admin-console) and, via direct Lambda invocation,
the MCP server. Every route requires a Cognito-authenticated session, and
consists of two Lambdas split by network placement: one in the VPC (for
Aurora and Valkey access) and one outside it (for AWS control-plane APIs
that the VPC's `natGateways: 0` layout cannot otherwise reach). Grouped by
what each area lets an operator do:

| Area | Covers |
| --- | --- |
| **Microservices** | Deploy a service from a GitHub repository's own Dockerfile, build, launch, restart, roll back, read logs and metrics, tear down. |
| **Sensors** | Register, enable/disable, adjust streaming and archive settings, reconcile runtime infrastructure. |
| **Clusters** | List, health-check, create, resize, provision and deprovision compute capacity. |
| **Apps & clients** | Manage app registrations, count and inspect connected clients, search by radius. |
| **Storage** | List buckets, browse objects, register/unregister buckets as sensor upload targets. |
| **Data** | Query Aurora, read and edit rows, inspect and repair Valkey keys. |
| **Operations** | CloudWatch alarms and Insights queries, network topology, cost breakdown, user management, system info. |
| **GitHub** | Manage the GitHub App installation microservice deployment depends on. |
| **MCP tokens** | Issue and revoke the long-lived tokens MCP clients authenticate with. |

### MCP server

`POST /mcp` implements JSON-RPC 2.0 over the MCP 2024-11-05 spec
(Streamable HTTP transport), giving any MCP-capable AI assistant the same
capabilities listed under [Admin API](#admin-api-cognito-protected) above,
gated by the role attached to the token used to connect. Authentication is a
long-lived, revocable token (not a Cognito session) issued from the console,
because an assistant's configuration is read once at startup with nowhere
to put an hourly refresh. Setup instructions for Claude Desktop, Claude
Code, Cursor, Windsurf, and the Gemini CLI are generated live on the
console's MCP page, pre-filled with a token you create there.

### GitHub integration

`POST /v1/github/webhook` is the one unauthenticated route that can trigger
a deployment: GitHub delivers push events here, verified by an HMAC
signature over the raw body, which then drives a microservice's build and
redeploy. It sits on the public API rather than the admin one because a
webhook carries no bearer token — only a signature the Cognito authorizer
would refuse before it could be checked.

## API documentation

Every deployment serves its own live, always-current OpenAPI document —
there is no separate build step that can drift from the deployed code:

- `GET {HttpApiUrl}/system/docs` — interactive Swagger UI.
- `GET {HttpApiUrl}/system/openapi.json` — the raw OpenAPI 3.0 document.

`{HttpApiUrl}` is printed as a CloudFormation output after you deploy (see
[Getting started](#getting-started)), and shown in the admin console's
**API Docs** page. The document covers only the
[public client API](#public-client-api) — the admin API, MCP server, and
GitHub webhook exist to operate the deployment rather than to be integrated
against, and are intentionally left out.

## Repository layout

```
lib/msight-cloud-stack.ts     CDK stack: every AWS resource this project creates
bin/msight-cloud.js           CDK app entry point, reads deploy.config.yaml
src/functions/                One directory per Lambda (TypeScript or Python)
src/services/sensor-consumer/ The per-sensor ECS Fargate container
src/shared/                   Zod schemas, the OpenAPI generator, admin-api routing/middleware
admin-console/                Vue 3 + Quasar management console (deployed to S3 + CloudFront)
test/                         Jest (TypeScript) and unittest (Python) test suites
deploy.config.example.yaml    Template for deploy.config.yaml (gitignored, holds real account values)
deploy.js                     npm run deploy: cdk deploy, then build/upload the admin console
```

## Getting started

### Prerequisites

- An AWS account and credentials configured locally (`aws configure`).
- Node.js 20+ and npm.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/), running
  — CDK builds a container image for the sensor consumer service at deploy
  time.
- The [AWS CDK CLI](https://docs.aws.amazon.com/cdk/) (installed as a
  dependency; `npx cdk` works without a global install).

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

```bash
cp deploy.config.example.yaml deploy.config.yaml
```

Fill in your AWS account ID, region, and admin console master credentials.
`deploy.config.yaml` is gitignored — every setting is documented inline in
the example file, including which ones are safe to change later and which
ones replace live resources if changed after the first deploy.

### 3. Build

```bash
npm run build
```

### 4. Review the changes CDK will make

```bash
npx cdk diff MsightCloudStack --no-change-set
```

### 5. Deploy

```bash
npm run deploy
```

This runs `cdk deploy`, then builds the admin console against the
deployment's own API URLs and Cognito pool, uploads it to S3, and
invalidates CloudFront. (You can run `npx cdk deploy MsightCloudStack
--require-approval never` directly if you only want the infrastructure,
without touching the console.)

### 6. Verify

```text
GET {HttpApiUrl}/system/version
```

using the `HttpApiUrl` printed in the deploy output. A response with a
`build_id` confirms you're hitting the code you just deployed.

```json
{
  "service": "system-api",
  "api_version": "v1",
  "build_id": "<hash>",
  "server_timestamp": "<iso timestamp>"
}
```

The deploy output also prints the admin console's CloudFront URL — sign in
with the `masterUsername` / `masterPassword` from `deploy.config.yaml`.

### Optional deployment variants

**Preferred-AZ, low-latency layout.** The stack always deploys with subnets
pinned toward a single AZ (required for the VPC's `natGateways: 0` layout).
To pin it explicitly:

```bash
npx cdk deploy MsightCloudStack --require-approval never -c preferredAz=us-east-2a
```

**Debug-only Valkey inspector.** Set `debugMode: true` in
`deploy.config.yaml` (or pass `-c debugMode=true`) to deploy a temporary
Lambda that can read Valkey from inside the VPC. Deploy output then includes
`CacheDebugLambdaName`:

```bash
aws lambda invoke --function-name <CacheDebugLambdaName> \
  --payload '{"action":"ping"}' --cli-binary-format raw-in-base64-out \
  /tmp/cache-debug.json && cat /tmp/cache-debug.json
```

Supported actions: `ping`, `get`, `set`, `ttl`, `type`, `exists`, `del`. Do
not enable this in a deployment reachable by anyone you don't trust with
direct cache access.

Windows PowerShell note: if script execution is restricted, run CDK
commands via `npx.cmd` (e.g. `npx.cmd cdk synth`).

## Configuration

All deployment-time configuration lives in `deploy.config.yaml`; see
[`deploy.config.example.yaml`](./deploy.config.example.yaml) for the full,
documented set of options, including:

- AWS account/region and preferred availability zone.
- Resource tagging for cost allocation.
- Admin console master account and allowed CORS origins.
- Which client app IDs the console may inspect.
- SPaT broadcast radius, config cache TTL, and CloudWatch log retention.
- Deployment name and pinned resource names (for adopting or renaming an
  existing deployment without replacing its resources).

## Admin console

A Vue 3 + Quasar single-page app in `admin-console/`, deployed to S3 and
served through CloudFront, authenticated against the Cognito user pool this
stack creates. It has no self-registration — the master account from
`deploy.config.yaml` is the only way in initially, and can create further
accounts from its Users page. See [`admin-console/README.md`](./admin-console/README.md)
for local development instructions.

## Development

```bash
npm run build       # compile TypeScript
npm run watch        # recompile on change
npm test             # Jest test suite (TypeScript)
npm run test:python  # unittest suite (Python Lambda/ECS code)
```

## Tech stack

- **Infrastructure**: AWS CDK (TypeScript), deployed as a single
  CloudFormation stack.
- **Compute**: AWS Lambda (Node.js and Python) and ECS Fargate (one task per
  sensor).
- **Data**: Aurora PostgreSQL with PostGIS, Valkey (ElastiCache), S3.
- **Messaging**: SNS (fan-out) and SQS FIFO (ordered, per-sensor delivery).
- **API**: API Gateway HTTP APIs and a WebSocket API; OpenAPI 3.0 generated
  from Zod schemas via `@asteasolutions/zod-to-openapi`.
- **Auth**: Cognito (console and admin API), a custom Lambda authorizer with
  long-lived tokens (MCP), HMAC signature verification (GitHub webhook).
- **Console**: Vue 3, Quasar.
- **AI integration**: an MCP (Model Context Protocol) server over
  Streamable HTTP.

## Security notes

- The admin API and console are Cognito-authenticated; there is no
  anonymous access to any administrative capability.
- The VPC runs with `natGateways: 0` — Lambdas that need internet access
  (e.g. to call GitHub's API) are deliberately split into their own
  out-of-VPC functions rather than given a NAT path, so a compromise of one
  cannot reach both the internet and Aurora.
- MCP tokens are stored hashed; the plaintext is shown exactly once, at
  creation.
- The GitHub webhook validates an HMAC signature over the raw request body
  before anything is parsed, and holds no database access of its own.
- Secrets (database credentials, the GitHub App private key) are held in
  AWS Secrets Manager, never in environment variables or logs.

Found a security issue? Please report it privately rather than opening a
public issue — see [Contributing](#contributing) below for contact details
once they're published.

## Contributing

Contribution guidelines are still being written for this first release.
Until then, feel free to open an issue to discuss a change before sending a
pull request.

## License

BSD 3-Clause. See [`LICENSE`](./LICENSE) for the full text.
