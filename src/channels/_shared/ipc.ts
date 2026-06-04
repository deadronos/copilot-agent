import { createLogger } from '../../logger.js';

const log = createLogger('ipc');

// ── Types ────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface IpcHandler {
  handleRequest(method: string, params?: unknown): Promise<unknown>;
}

// ── In-flight tracking ───────────────────────────────────────────────

const pendingRequests = new Map<
  string | number,
  { resolve: (value: unknown) => void; reject: (err: Error) => void }
>();

let nextId = 1;

// ── Server (listens on stdin → stdout) ───────────────────────────────

export async function startIpcServer(handler: IpcHandler): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  let buffer = '';

  stdin.setEncoding('utf-8');
  stdin.resume();

  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    // The last element may be incomplete; keep it in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: JsonRpcRequest | JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        log.warn({ line: trimmed.slice(0, 200) }, 'Invalid JSON on stdin');
        continue;
      }

      if ('method' in msg) {
        void handleIncomingRequest(handler, msg, stdout);
      } else {
        handleIncomingResponse(msg);
      }
    }
  });

  log.info('IPC server listening on stdin/stdout');
}

async function handleIncomingRequest(
  handler: IpcHandler,
  req: JsonRpcRequest,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  try {
    const result = await handler.handleRequest(req.method, req.params);
    sendResponse(stdout, { jsonrpc: '2.0', id: req.id, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendResponse(stdout, {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32603, message },
    });
  }
}

function handleIncomingResponse(res: JsonRpcResponse): void {
  const pending = pendingRequests.get(res.id);
  if (!pending) {
    log.warn({ id: res.id }, 'Received response for unknown request');
    return;
  }
  pendingRequests.delete(res.id);

  if (res.error) {
    pending.reject(new Error(res.error.message));
  } else {
    pending.resolve(res.result);
  }
}

function sendResponse(stdout: NodeJS.WriteStream, res: JsonRpcResponse): void {
  stdout.write(JSON.stringify(res) + '\n');
}

// ── Client ───────────────────────────────────────────────────────────

export function sendIpcRequest(
  method: string,
  params?: unknown,
): Promise<unknown> {
  const id = nextId++;
  const req: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    process.stdout.write(JSON.stringify(req) + '\n');
  });
}
