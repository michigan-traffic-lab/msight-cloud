import * as net from 'node:net';
import * as tls from 'node:tls';

export type ValkeyResponse = string | number | null | ValkeyResponse[];

type ValkeySocket = tls.TLSSocket | net.Socket;

type ValkeyInFlightCommand = {
  resolve: (response: ValkeyResponse) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
};

type ValkeyConnection = {
  socket: ValkeySocket;
  responseBuffer: string;
  inFlightCommand: ValkeyInFlightCommand | null;
};

let valkeyConnectionPromise: Promise<ValkeyConnection> | null = null;
let valkeyCommandQueue: Promise<unknown> = Promise.resolve();

function resetValkeyConnection(): void {
  valkeyConnectionPromise = null;
}

function settleValkeyInFlightCommand(
  connection: ValkeyConnection,
  outcome: { response?: ValkeyResponse; error?: Error }
): void {
  const inFlightCommand = connection.inFlightCommand;
  if (!inFlightCommand) {
    return;
  }

  connection.inFlightCommand = null;
  clearTimeout(inFlightCommand.timeoutHandle);

  if (outcome.error) {
    inFlightCommand.reject(outcome.error);
    return;
  }

  inFlightCommand.resolve(outcome.response ?? '');
}

function parseValkeyResponse(
  buffer: string,
  startIndex = 0
): { value: ValkeyResponse; nextIndex: number } | null {
  if (startIndex >= buffer.length) {
    return null;
  }

  const prefix = buffer[startIndex];

  if (prefix === '+' || prefix === ':') {
    const lineTerminatorIndex = buffer.indexOf('\r\n', startIndex);
    if (lineTerminatorIndex === -1) {
      return null;
    }

    const rawValue = buffer.slice(startIndex + 1, lineTerminatorIndex);
    const value = prefix === ':' ? Number(rawValue) : rawValue;
    return {
      value,
      nextIndex: lineTerminatorIndex + 2,
    };
  }

  if (prefix === '$') {
    const lineTerminatorIndex = buffer.indexOf('\r\n', startIndex);
    if (lineTerminatorIndex === -1) {
      return null;
    }

    const lengthValue = Number(buffer.slice(startIndex + 1, lineTerminatorIndex));
    if (!Number.isInteger(lengthValue)) {
      throw new Error('Invalid bulk string length returned by Valkey');
    }

    if (lengthValue === -1) {
      return {
        value: null,
        nextIndex: lineTerminatorIndex + 2,
      };
    }

    const valueStartIndex = lineTerminatorIndex + 2;
    const valueEndIndex = valueStartIndex + lengthValue;
    const nextIndex = valueEndIndex + 2;

    if (buffer.length < nextIndex) {
      return null;
    }

    return {
      value: buffer.slice(valueStartIndex, valueEndIndex),
      nextIndex,
    };
  }

  if (prefix === '*') {
    const lineTerminatorIndex = buffer.indexOf('\r\n', startIndex);
    if (lineTerminatorIndex === -1) {
      return null;
    }

    const lengthValue = Number(buffer.slice(startIndex + 1, lineTerminatorIndex));
    if (!Number.isInteger(lengthValue)) {
      throw new Error('Invalid array length returned by Valkey');
    }

    if (lengthValue === -1) {
      return {
        value: null,
        nextIndex: lineTerminatorIndex + 2,
      };
    }

    const values: ValkeyResponse[] = [];
    let cursor = lineTerminatorIndex + 2;

    for (let index = 0; index < lengthValue; index += 1) {
      const nested = parseValkeyResponse(buffer, cursor);
      if (!nested) {
        return null;
      }

      values.push(nested.value);
      cursor = nested.nextIndex;
    }

    return {
      value: values,
      nextIndex: cursor,
    };
  }

  throw new Error(`Unsupported Valkey response prefix: ${prefix}`);
}

function processValkeyResponseBuffer(connection: ValkeyConnection): void {
  if (!connection.inFlightCommand) {
    return;
  }

  if (connection.responseBuffer.length === 0) {
    return;
  }

  try {
    if (connection.responseBuffer[0] === '-') {
      const lineTerminatorIndex = connection.responseBuffer.indexOf('\r\n');
      if (lineTerminatorIndex === -1) {
        return;
      }

      const line = connection.responseBuffer.slice(1, lineTerminatorIndex);
      connection.responseBuffer = connection.responseBuffer.slice(lineTerminatorIndex + 2);
      settleValkeyInFlightCommand(connection, { error: new Error(line) });
      return;
    }

    const parsed = parseValkeyResponse(connection.responseBuffer);
    if (!parsed) {
      return;
    }

    connection.responseBuffer = connection.responseBuffer.slice(parsed.nextIndex);
    settleValkeyInFlightCommand(connection, { response: parsed.value });
  } catch (error) {
    settleValkeyInFlightCommand(connection, {
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

function encodeValkeyCommand(args: Array<string | number>): string {
  const parts = [`*${args.length}\r\n`];

  for (const arg of args) {
    const value = String(arg);
    parts.push(`$${Buffer.byteLength(value, 'utf8')}\r\n${value}\r\n`);
  }

  return parts.join('');
}

async function createValkeyConnection(): Promise<ValkeyConnection> {
  const host = process.env.CACHE_HOST;
  const port = Number(process.env.CACHE_PORT ?? '6379');
  const useTls = (process.env.CACHE_TLS_ENABLED ?? 'true').toLowerCase() !== 'false';
  const connectTimeoutMs = Number(process.env.CACHE_CONNECT_TIMEOUT_MS ?? '5000');

  if (!host) {
    throw new Error('CACHE_HOST is not set');
  }

  return new Promise<ValkeyConnection>((resolve, reject) => {
    const socket = useTls
      ? tls.connect({ host, port, rejectUnauthorized: false })
      : net.connect({ host, port });

    const connection: ValkeyConnection = {
      socket,
      responseBuffer: '',
      inFlightCommand: null,
    };

    let settled = false;

    const connectTimeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resetValkeyConnection();
      reject(new Error(`Valkey connection timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    const finishConnection = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(connectTimeoutHandle);
      callback();
    };

    socket.on('data', (chunk) => {
      connection.responseBuffer += chunk.toString('utf8');
      processValkeyResponseBuffer(connection);
    });

    socket.on('error', (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      finishConnection(() => {
        resetValkeyConnection();
        reject(normalizedError);
      });

      settleValkeyInFlightCommand(connection, { error: normalizedError });
      resetValkeyConnection();
    });

    socket.on('close', () => {
      const closeError = new Error('Valkey connection closed');

      finishConnection(() => {
        resetValkeyConnection();
        reject(closeError);
      });

      settleValkeyInFlightCommand(connection, { error: closeError });
      resetValkeyConnection();
    });

    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      finishConnection(() => resolve(connection));
    });
  });
}

async function getValkeyConnection(): Promise<ValkeyConnection> {
  if (!valkeyConnectionPromise) {
    valkeyConnectionPromise = createValkeyConnection().catch((error) => {
      resetValkeyConnection();
      throw error;
    });
  }

  return valkeyConnectionPromise;
}

async function enqueueValkeyCommand<T>(operation: () => Promise<T>): Promise<T> {
  const queuedOperation = valkeyCommandQueue.then(operation, operation);
  valkeyCommandQueue = queuedOperation.then(
    () => undefined,
    () => undefined
  );
  return queuedOperation;
}

export async function sendValkeyCommand(
  command: string,
  timeoutMs = Number(process.env.CACHE_TIMEOUT_MS ?? '5000')
): Promise<ValkeyResponse> {
  return enqueueValkeyCommand(async () => {
    const connection = await getValkeyConnection();

    return new Promise<ValkeyResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        connection.socket.destroy();
        settleValkeyInFlightCommand(connection, {
          error: new Error(`Timed out after ${timeoutMs}ms`),
        });
        resetValkeyConnection();
      }, timeoutMs);

      connection.inFlightCommand = {
        resolve,
        reject,
        timeoutHandle,
      };

      connection.socket.write(command, (error) => {
        if (!error) {
          return;
        }

        settleValkeyInFlightCommand(connection, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        connection.socket.destroy();
        resetValkeyConnection();
      });
    });
  });
}

export async function sendValkeyArrayCommand(
  args: Array<string | number>,
  timeoutMs = Number(process.env.CACHE_TIMEOUT_MS ?? '5000')
): Promise<ValkeyResponse> {
  return sendValkeyCommand(encodeValkeyCommand(args), timeoutMs);
}

export async function pingValkey(
  timeoutMs = Number(process.env.CACHE_TIMEOUT_MS ?? '5000')
): Promise<string> {
  const response = await sendValkeyArrayCommand(['PING'], timeoutMs);
  return response === null ? '' : String(response);
}