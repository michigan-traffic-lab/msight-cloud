#!/usr/bin/env node

const readline = require('node:readline');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

function parseArgs(argv) {
  const config = {
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2',
    functionName: '',
    profile: process.env.AWS_PROFILE || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--region' && argv[i + 1]) {
      config.region = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--function' && argv[i + 1]) {
      config.functionName = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--profile' && argv[i + 1]) {
      config.profile = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--help' || token === '-h') {
      config.help = true;
      continue;
    }
  }

  return config;
}

function tokenize(input) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;

  while ((match = pattern.exec(input)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\"/g, '"'));
    } else if (match[2] !== undefined) {
      tokens.push(match[2].replace(/\\'/g, "'"));
    } else {
      tokens.push(match[3]);
    }
  }

  return tokens;
}

function printUsage() {
  console.log('Usage:');
  console.log('  node tools/debug_client/cache_debug.js --function <lambda-name> [--region us-east-2] [--profile profile]');
  console.log('');
  console.log('If --profile is provided, this script sets AWS_PROFILE for the process.');
}

function printHelp() {
  console.log('');
  console.log('Commands:');
  console.log('  help                          Show this help text');
  console.log('  config                        Show current region/function/profile');
  console.log('  set-region <region>           Update AWS region (recreates Lambda client)');
  console.log('  set-function <name>           Update Lambda function name');
  console.log('  examples                      Show common query examples');
  console.log('  ping                          Send {"action":"ping"}');
  console.log('  get <key>                     Send {"action":"get","key":"..."}');
  console.log('  set <key> <value> [ttl]       Send set; TTL is optional seconds');
  console.log('  ttl <key>                     Send TTL query');
  console.log('  type <key>                    Send TYPE query');
  console.log('  exists <key>                  Send EXISTS query');
  console.log('  del <key>                     Send DEL query');
  console.log('  scan <patternOrPrefix> [max]  Scan keys by pattern (prefix auto-appends *)');
  console.log('  dump <patternOrPrefix> [max]  Fetch key/value entries for matching keys');
  console.log('  raw <json>                    Send a fully custom payload JSON');
  console.log('  exit | quit                   Exit the debugger');
  console.log('');
  console.log('Tips:');
  console.log("  - Quote values with spaces: set my:key \"hello world\" 120");
  console.log("  - Start with 'ping', then 'type <key>', then 'get <key>' to inspect safely.");
  console.log("  - For prefix lookup use: scan msight    (expands to pattern 'msight*').");
  console.log("  - For key/value pairs use: dump msight- (expands to pattern 'msight-*').");
  console.log('');
}

function printExamples() {
  console.log('');
  console.log('Examples:');
  console.log('  ping');
  console.log('  type location:device-123');
  console.log('  get location:device-123');
  console.log('  ttl location:device-123');
  console.log('  set test:key "temporary value" 180');
  console.log('  scan msight');
  console.log('  scan msight* 5000');
  console.log('  dump msight- 2000');
  console.log('  exists test:key');
  console.log('  del test:key');
  console.log('  raw {"action":"get","key":"location:device-123"}');
  console.log('');
}

function createLambdaClient(region) {
  return new LambdaClient({ region });
}

async function invokeLambda(lambdaClient, functionName, payload) {
  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload), 'utf8'),
  });

  const response = await lambdaClient.send(command);
  const rawPayload = response.Payload ? Buffer.from(response.Payload).toString('utf8') : '';

  let parsedPayload;
  if (rawPayload) {
    try {
      parsedPayload = JSON.parse(rawPayload);
    } catch {
      parsedPayload = rawPayload;
    }
  } else {
    parsedPayload = null;
  }

  return {
    statusCode: response.StatusCode,
    functionError: response.FunctionError || null,
    executedVersion: response.ExecutedVersion || null,
    payload: parsedPayload,
  };
}

function buildPayloadFromCommand(tokens) {
  const command = tokens[0];

  if (command === 'ping') {
    return { action: 'ping' };
  }

  if (command === 'get' || command === 'ttl' || command === 'type' || command === 'exists' || command === 'del') {
    if (!tokens[1]) {
      throw new Error(`${command} requires <key>. Example: ${command} location:device-123`);
    }
    return { action: command, key: tokens[1] };
  }

  if (command === 'set') {
    if (!tokens[1] || !tokens[2]) {
      throw new Error('set requires <key> <value> [ttl]. Example: set test:key "value" 120');
    }

    const payload = {
      action: 'set',
      key: tokens[1],
      value: tokens[2],
    };

    if (tokens[3] !== undefined) {
      const ttlSeconds = Number(tokens[3]);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw new Error('TTL must be a positive integer in seconds.');
      }
      payload.ttlSeconds = ttlSeconds;
    }

    return payload;
  }

  if (command === 'scan') {
    const patternOrPrefix = tokens[1] || 'msight';
    const hasWildcard = patternOrPrefix.includes('*') || patternOrPrefix.includes('?');
    const pattern = hasWildcard ? patternOrPrefix : `${patternOrPrefix}*`;

    const payload = {
      action: 'scan',
      pattern,
      count: 200,
    };

    if (tokens[2] !== undefined) {
      const maxKeys = Number(tokens[2]);
      if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
        throw new Error('scan [max] must be a positive integer. Example: scan msight 5000');
      }
      payload.maxKeys = maxKeys;
    }

    return payload;
  }

  if (command === 'dump') {
    const patternOrPrefix = tokens[1] || 'msight';
    const hasWildcard = patternOrPrefix.includes('*') || patternOrPrefix.includes('?');
    const pattern = hasWildcard ? patternOrPrefix : `${patternOrPrefix}*`;

    const payload = {
      action: 'dump',
      pattern,
      count: 200,
    };

    if (tokens[2] !== undefined) {
      const maxKeys = Number(tokens[2]);
      if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
        throw new Error('dump [max] must be a positive integer. Example: dump msight- 5000');
      }
      payload.maxKeys = maxKeys;
    }

    return payload;
  }

  if (command === 'raw') {
    if (!tokens[1]) {
      throw new Error('raw requires JSON payload. Example: raw {"action":"get","key":"k"}');
    }

    const rawText = tokens.slice(1).join(' ');
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON for raw payload: ${message}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Raw payload must be a JSON object.');
    }

    return parsed;
  }

  return null;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));

  if (config.help) {
    printUsage();
    printHelp();
    return;
  }

  if (config.profile) {
    process.env.AWS_PROFILE = config.profile;
  }

  let region = config.region;
  let functionName = config.functionName;
  let lambdaClient = createLambdaClient(region);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    const fnShort = functionName ? functionName : 'unset-function';
    rl.setPrompt(`cache-debug [${region}] [${fnShort}]> `);
    rl.prompt();
  };

  console.log('MSight Valkey Debug CLI');
  console.log('This tool invokes your debug Lambda and prints results with context.');
  console.log('Use "help" to see supported commands and examples.');
  console.log('');

  if (!functionName) {
    console.log('No Lambda function name set yet. Run: set-function <name>');
  }

  prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    const tokens = tokenize(trimmed);
    const command = tokens[0]?.toLowerCase();

    try {
      if (command === 'exit' || command === 'quit') {
        rl.close();
        return;
      }

      if (command === 'help') {
        printHelp();
        prompt();
        return;
      }

      if (command === 'examples') {
        printExamples();
        prompt();
        return;
      }

      if (command === 'config') {
        console.log(JSON.stringify({
          region,
          functionName: functionName || null,
          profile: process.env.AWS_PROFILE || null,
        }, null, 2));
        prompt();
        return;
      }

      if (command === 'set-region') {
        if (!tokens[1]) {
          throw new Error('set-region requires a value. Example: set-region us-east-2');
        }
        region = tokens[1];
        lambdaClient = createLambdaClient(region);
        console.log(`Region updated to ${region}`);
        prompt();
        return;
      }

      if (command === 'set-function') {
        if (!tokens[1]) {
          throw new Error('set-function requires a value. Example: set-function MyLambdaName');
        }
        functionName = tokens[1];
        console.log(`Function updated to ${functionName}`);
        prompt();
        return;
      }

      const payload = buildPayloadFromCommand(tokens);
      if (!payload) {
        console.log(`Unknown command: ${command}`);
        console.log('Type "help" for available commands.');
        prompt();
        return;
      }

      if (!functionName) {
        throw new Error('Lambda function name is not set. Run: set-function <name>');
      }

      console.log('Invoking with payload:');
      console.log(JSON.stringify(payload, null, 2));

      const result = await invokeLambda(lambdaClient, functionName, payload);
      console.log('Result:');
      console.log(JSON.stringify(result, null, 2));

      if (command === 'scan' && result.payload && typeof result.payload === 'object') {
        const lambdaPayload = result.payload;
        if (lambdaPayload && lambdaPayload.result && Array.isArray(lambdaPayload.result.keys)) {
          const keyCount = lambdaPayload.result.keys.length;
          const truncated = Boolean(lambdaPayload.result.truncated);
          console.log(`Scanned ${keyCount} key(s).${truncated ? ' Result truncated; rerun with higher max.' : ''}`);
        }
      }

      if (command === 'dump' && result.payload && typeof result.payload === 'object') {
        const lambdaPayload = result.payload;
        if (lambdaPayload && lambdaPayload.result && Array.isArray(lambdaPayload.result.entries)) {
          const keyCount = lambdaPayload.result.entries.length;
          const truncated = Boolean(lambdaPayload.result.truncated);
          console.log(`Fetched ${keyCount} key/value entr${keyCount === 1 ? 'y' : 'ies'}.${truncated ? ' Result truncated; rerun with higher max.' : ''}`);
        }
      }

      if (result.functionError) {
        console.log('Lambda reported a function error. Check payload and command shape above.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
    }

    prompt();
  });

  rl.on('close', () => {
    console.log('Exiting cache debug CLI.');
    process.exit(0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
