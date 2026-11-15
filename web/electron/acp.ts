// Minimal ACP (Agent Client Protocol) client: JSON-RPC 2.0, one JSON message per line over the agent's stdio.
// Spawns any user-registered agent command, so no provider is special-cased here.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export const PROTOCOL_VERSION = 1;

export interface PermissionOption { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }
export interface PermissionRequest { sessionId: string; options: PermissionOption[]; toolCall: { toolCallId: string; title?: string; kind?: string } }
export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
export interface ConfigOption {
  id: string; name: string; category?: string; type?: string; currentValue?: string;
  options?: ({ value: string; name: string; description?: string } | { group?: string; name?: string; options: { value: string; name: string }[] })[];
}
/** A way to sign the agent in. type "terminal" = run the agent command with `args` in a terminal. */
export interface AuthMethod { id: string; name: string; description?: string; type?: string; args?: string[] }
export interface McpServerStdio { name: string; command: string; args: string[]; env: { name: string; value: string }[] }

export interface AgentHandlers {
  /** Every `session/update` notification (agent_message_chunk, tool_call, plan, usage_update…). */
  onUpdate: (update: Record<string, unknown> & { sessionUpdate: string }) => void;
  /** `session/request_permission`: resolve with the user's choice. */
  onPermission: (req: PermissionRequest) => Promise<PermissionOutcome>;
  onExit: (code: number | null, stderrTail: string) => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class AcpError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class AcpAgent {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = '';
  private handlers: AgentHandlers;
  sessionId = '';
  agentInfo: unknown = null;
  configOptions: ConfigOption[] = [];
  authMethods: AuthMethod[] = [];

  constructor(handlers: AgentHandlers) {
    this.handlers = handlers;
  }

  /** Start the agent process. `command` is a full shell command line, e.g. "npx -y @agentclientprotocol/codex-acp". */
  start(command: string, cwd: string) {
    const proc = spawn(command, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stderr!.on('data', d => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
    createInterface({ input: proc.stdout! }).on('line', line => this.onLine(line));
    proc.on('exit', code => {
      for (const p of this.pending.values()) p.reject(new AcpError(-32000, `agent exited (${code})`, this.stderr));
      this.pending.clear();
      this.handlers.onExit(code, this.stderr);
    });
    proc.on('error', err => this.handlers.onExit(null, `${err.message}\n${this.stderr}`));
  }

  async initialize() {
    const res = await this.request<{ protocolVersion: number; agentInfo?: unknown; authMethods?: AuthMethod[] }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // Standlink does not serve files or terminals: the agent uses its own tools in the project folder.
      // auth.terminal: we can open a terminal for the agent's own login command (the user signs in there, not us)
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
      clientInfo: { name: 'standlink', version: '0.1.0' },
    });
    this.agentInfo = res.agentInfo ?? null;
    this.authMethods = res.authMethods ?? [];
    return res;
  }

  async newSession(cwd: string, mcpServers: McpServerStdio[] = []) {
    const res = await this.request<{ sessionId: string; configOptions?: ConfigOption[] }>('session/new', { cwd, mcpServers });
    this.sessionId = res.sessionId;
    this.configOptions = res.configOptions ?? [];
    return res.sessionId;
  }

  /** ACP session config (model, reasoning effort, mode…), whatever this agent advertises. */
  async setConfigOption(configId: string, value: string) {
    const res = await this.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: this.sessionId, configId, value });
    if (res?.configOptions) this.configOptions = res.configOptions;
    return this.configOptions;
  }

  /** One prompt turn. Resolves with the stop reason when the agent finishes the turn. */
  async prompt(text: string) {
    const res = await this.request<{ stopReason: string }>('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    });
    return res.stopReason;
  }

  cancel() {
    if (this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
  }

  kill() {
    this.proc?.kill();
    this.proc = null;
  }

  private write(msg: object) {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private request<T>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: v => resolve(v as T), reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: object) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private async onLine(line: string) {
    let msg: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try { msg = JSON.parse(line); } catch { return; } // agents may print non-protocol noise; ignore it

    // Response to one of our requests
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new AcpError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    // Notification from the agent
    if (msg.method && msg.id === undefined) {
      if (msg.method === 'session/update') this.handlers.onUpdate(msg.params.update);
      return;
    }
    // Request from the agent: answer it or the agent blocks forever
    if (msg.method && msg.id !== undefined) {
      try {
        if (msg.method === 'session/request_permission') {
          const outcome = await this.handlers.onPermission(msg.params as PermissionRequest);
          this.write({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
        } else {
          this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported by client: ${msg.method}` } });
        }
      } catch (e) {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: (e as Error).message } });
      }
    }
  }
}

/** ACP auth_required (-32000) or an agent that says it needs a login. */
export function isAuthRequired(err: unknown): boolean {
  return err instanceof AcpError && /auth|log ?in|sign ?in|credential/i.test(`${err.message} ${JSON.stringify(err.data ?? '')}`);
}

/** Heuristic: does this error mean the provider's usage quota ran out (not a normal failure)? */
export function isRateLimit(err: unknown): boolean {
  const text = err instanceof AcpError ? `${err.message} ${JSON.stringify(err.data ?? '')}` : String(err);
  return /rate.?limit|usage.?limit|quota|429|too many requests|limit reached|exceeded/i.test(text);
}
