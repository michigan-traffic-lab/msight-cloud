# MSight Cloud

MSight Cloud is the cloud platform that coordinates with MSight roadside devices. It is designed to receive and process sensor streams from roadside edge devices, archive and manage sensor data, and provide a comprehensive set of APIs for users and applications to interact with the platform. Through these APIs, MSight Cloud supports a wide range of functionalities, including real-time sensor data streaming, low-latency warning delivery to mobile devices, online SAE J2735 message decoding, and real-time SPaT updates to mobile devices.


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

MSight Cloud abstracts each roadside data stream as a logical **sensor**, allowing different sensor streams to be handled independently according to their data characteristics and application requirements. For sensor data that requires real-time processing and delivery, MSight Cloud can provision an **Amazon SNS FIFO topic**. SNS FIFO provides ordered message delivery within a message group and message deduplication, enabling reliable low-latency distribution of sequential sensor data to downstream services. MSight Cloud can further expose these streams through real-time **WebSocket connections**, allowing authorized applications and clients to subscribe to and receive sensor updates with low latency.

For sensor data that does not require real-time delivery, data can be buffered, processed, and aggregated at the roadside using **MSight Core**, which provides modular processing nodes for functions such as buffering, sorting, aggregation, transformation, and cloud forwarding. The aggregated data can then be uploaded to the cloud storage bucket configured and managed through MSight Cloud.

In addition to general-purpose sensor streams, MSight Cloud provides dedicated services for connected-vehicle and traffic-signal applications. The platform maintains a **real-time SPaT streaming topic** for receiving and distributing Signal Phase and Timing information represented using the SAE J2735 SPaT message structure. SPaT updates can subsequently be delivered to client applications through WebSocket streams, enabling clients to continuously receive current traffic-signal states.

MSight Cloud also provides location-aware APIs for mobile and connected-vehicle clients. Based on a client's reported location, the platform can deliver **real-time warning messages** associated with nearby roadway events and provide the corresponding **intersection map information**, containing the roadway and intersection geometry represented by the SAE J2735 MAP message.


## Architecture

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
admin-console/.env.example    Template for admin-console/.env — written by deploy.js, not by hand
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
npm install --prefix admin-console
```

Two installs, because the console is a separate package rather than a
workspace. Skipping the second one gets you all the way to the console build
inside `npm run deploy` before it fails.

### 2. Configure

```bash
cp deploy.config.example.yaml deploy.config.yaml
```

Fill in your AWS account ID, region, and admin console master credentials.
`deploy.config.yaml` is gitignored — every setting is documented inline in
the example file, including which ones are safe to change later and which
ones replace live resources if changed after the first deploy.

This is the only file you fill in. Everything else the deployment needs is
derived from it or from the stack's own outputs.

### 3. Deploy

```bash
npm run deploy
```

That is the whole deployment. It runs `cdk deploy`, then builds the admin
console against the deployment's own API URLs and Cognito pool, uploads it to
S3, and invalidates CloudFront.

No build step is needed first: CDK runs the TypeScript directly through
`ts-node`, so `npm run build` is a type-check rather than a prerequisite. See
[Other commands](#other-commands) for that and for reviewing changes before
they are applied.

### 4. Verify

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

### Other commands

None of these are needed to deploy. They are the things worth running when
you are changing the code rather than standing it up.

```bash
npx cdk diff MsightCloudStack --no-change-set   # what a deploy would change
npm run build                                   # type-check (tsc); not a deploy prerequisite
npm test                                        # Jest suite (TypeScript)
npm run test:python                             # unittest suite (Python Lambda/ECS code)
npx cdk synth MsightCloudStack                  # render the CloudFormation template
```

`cdk diff` before a deploy is worth the thirty seconds on anything already
carrying data: it names the resources that would be **replaced** rather than
updated, which for a database or a user pool means a new empty one.

**Deploying only the infrastructure.** `npx cdk deploy MsightCloudStack
--require-approval never` deploys the stack without touching the admin
console, which then keeps serving the previously uploaded build. Useful when
you have changed nothing in `admin-console/`, and a trap when you have —
prefer `npm run deploy` unless you specifically want this.

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
accounts from its Users page.

`npm run deploy` builds and uploads it as part of every deploy, configured
from the stack's own outputs — there is nothing to set up for it separately.

See [`admin-console/README.md`](./admin-console/README.md) for running it
locally against a deployment while working on the UI.

## Development

```bash
npm run watch        # type-check on change
npm test             # Jest suite (TypeScript)
npm run test:python  # unittest suite (Python Lambda/ECS code)
```

The Jest suite covers the Lambdas, the CDK stack, and the console's pure
TypeScript modules; the console's components are type-checked by its own
build. See [Other commands](#other-commands) for the CDK ones, and
[`admin-console/README.md`](./admin-console/README.md) for working on the UI.

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
