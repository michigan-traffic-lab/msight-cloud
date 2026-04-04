# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

Windows PowerShell note: if script execution is restricted, run CDK commands with `npx.cmd` (for example, `npx.cmd cdk synth`).

## Deployment instructions

### 1. Install dependencies

```bash
npm install
```

### 2. Build locally

```bash
npm run build
```

### 3. Review infrastructure/code changes

```bash
npx cdk diff MsightCloudStack --no-change-set
```

### 4. Deploy

```bash
npx cdk deploy MsightCloudStack --require-approval never
```

### Preferred-AZ Low-Latency Deployment

This stack now always deploys with the extreme-latency layout. To pin the preferred AZ explicitly, pass `preferredAz`:

```bash
npx cdk deploy MsightCloudStack --require-approval never -c preferredAz=us-east-2a
```

What this deployment does:

* Keeps VPC at 2 AZs (required by Aurora subnet coverage) and disables NAT gateways.
* Places app subnets in isolated private subnets and pins Lambda placement to `preferredAz` when provided.
* Keeps RDS Proxy subnet coverage across AZs to satisfy service requirements.
* Adds a Secrets Manager VPC interface endpoint.

### Debug-only Valkey Inspector Lambda

To deploy a temporary Lambda that can inspect Valkey from inside the VPC, enable `debugMode`:

```bash
npx cdk deploy MsightCloudStack --require-approval never -c preferredAz=us-east-2a -c debugMode=true
```

When `debugMode=true`, deploy outputs include `CacheDebugLambdaName` and `CacheDebugInvokeExample`.

Example invoke commands:

```bash
aws lambda invoke --function-name <CacheDebugLambdaName> --payload '{"action":"ping"}' --cli-binary-format raw-in-base64-out /tmp/cache-debug.json && cat /tmp/cache-debug.json
aws lambda invoke --function-name <CacheDebugLambdaName> --payload '{"action":"get","key":"location:device-123"}' --cli-binary-format raw-in-base64-out /tmp/cache-debug.json && cat /tmp/cache-debug.json
```

Supported actions: `ping`, `get`, `set`, `ttl`, `type`, `exists`, `del`.

In production mode (default), do not pass `debugMode=true`; the debug Lambda and related outputs are not created.

### 5. Verify the deployed version

Use the `HttpApiUrl` from deploy output and call:

```text
GET <HttpApiUrl>/system/version
```

Example:

```text
https://6ngwyshn4e.execute-api.us-east-1.amazonaws.com/system/version
```

Expected shape:

```json
{
	"service": "system-api",
	"api_version": "v1",
	"build_id": "<hash>",
	"server_timestamp": "<iso timestamp>"
}
```

If `build_id` changes after code edits and deploy, you are hitting the newest deployed Lambda.
