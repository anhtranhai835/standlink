// UI side of the Electron bridge. In a plain browser `bridge` is undefined and the app runs the offline demo.
import type { AgentId, Ev, PermOption } from './world';

export type AgentMsg =
  | { type: 'update'; update: AcpUpdate }
  | { type: 'permission'; reqId: string; title: string; options: PermOption[] }
  | { type: 'turn-end'; stopReason: string }
  | { type: 'error'; message: string; rateLimit: boolean }
  | { type: 'exit'; code: number | null; stderr: string };

export interface AcpEventMsg { projectId: string; memberId: AgentId; msg: AgentMsg }

export interface StandlinkApi {
  prompt(a: { projectId: string; memberId: AgentId; cmd: string; cwd: string; text: string }): Promise<null>;
  cancel(projectId: string, memberId: AgentId): Promise<void>;
  permission(reqId: string, optionId: string | null): Promise<void>;
  stop(projectId: string, memberId: AgentId): Promise<void>;
  pickFolder(): Promise<string | null>;
  onEvent(cb: (e: AcpEventMsg) => void): () => void;
  /** A team tool (board / assign / ask) called by an agent through the MCP bridge. */
  onMcpCall(cb: (c: McpCall) => void): () => void;
  mcpReply(callId: string, text: string, isError?: boolean): Promise<void>;
}

export interface McpCall { callId: string; projectId: string; memberId: AgentId; tool: string; args: Record<string, unknown> }

export const bridge: StandlinkApi | undefined = (window as unknown as { standlink?: StandlinkApi }).standlink;

/** The subset of ACP session/update payloads Standlink reads. */
interface AcpUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  title?: string;
  kind?: string;
  locations?: { path: string }[];
  entries?: { status?: string }[];
  used?: number;
  size?: number;
}

/** Translate one ACP session/update into UI events. Unknown kinds are ignored on purpose. */
export function updateToEvents(agent: AgentId, u: AcpUpdate): Ev[] {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return u.content?.type === 'text' && u.content.text ? [{ t: 'stream', agent, text: u.content.text }] : [];
    case 'tool_call':
      return [{ t: 'activity', agent, label: u.title || u.kind || 'tool', file: u.locations?.[0]?.path }];
    case 'plan': {
      const e = u.entries ?? [];
      return [{ t: 'plan', agent, total: e.length, done: e.filter(x => x.status === 'completed').length }];
    }
    case 'usage_update':
      return typeof u.used === 'number' ? [{ t: 'usage', agent, used: u.used, size: u.size ?? 0 }] : [];
    default:
      return [];
  }
}
