import { fork, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ChannelMessage, AgentResponse } from '../plugins/types';
import { SessionManager } from './sessionManager';

interface AgentProcess {
  process: ChildProcess;
  sessionId: string;
  lastActive: Date;
}

export type ResponseHandler = (sessionId: string, response: AgentResponse) => Promise<void>;

export class AgentSupervisor {
  private agents = new Map<string, AgentProcess>();
  private maxAgents: number;
  private idleTimeoutMs: number;
  private sessionManager: SessionManager;
  private onResponse: ResponseHandler;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(opts: {
    sessionManager: SessionManager;
    onResponse: ResponseHandler;
    maxAgents?: number;
    idleTimeoutMs?: number;
  }) {
    this.sessionManager = opts.sessionManager;
    this.onResponse = opts.onResponse;
    this.maxAgents = opts.maxAgents || 10;
    this.idleTimeoutMs = opts.idleTimeoutMs || 10 * 60 * 1000; // 10 min
  }

  start(): void {
    // Periodic cleanup of idle agents
    this.cleanupInterval = setInterval(() => this.cleanupIdle(), 60_000);
  }

  async routeMessage(message: ChannelMessage): Promise<void> {
    const session = this.sessionManager.resolveSession(
      message.channelType, message.channelId,
      message.userId, message.threadId
    );

    let agent = this.agents.get(session.id);
    if (!agent || !agent.process.connected) {
      agent = this.spawnAgent(session.id);
      this.agents.set(session.id, agent);
    }

    agent.lastActive = new Date();
    agent.process.send({ type: 'message', sessionId: session.id, message });
  }

  private spawnAgent(sessionId: string): AgentProcess {
    if (this.agents.size >= this.maxAgents) {
      this.evictOldest();
    }

    const agentEntry = this.resolveAgentEntry();
    const execArgv = this.resolveAgentExecArgv(agentEntry);
    const child = fork(agentEntry, [], {
      execArgv,
      env: { ...process.env, SESSION_ID: sessionId },
    });

    // Track PID in session
    this.sessionManager.setAgentPid(sessionId, child.pid || null);

    child.on('message', (msg: any) => {
      if (msg.type === 'response_complete') {
        this.onResponse(msg.sessionId, { text: msg.content });
      } else if (msg.type === 'stream_chunk') {
        this.onResponse(msg.sessionId, { text: msg.content, isChunk: true, messageId: msg.messageId } as any);
      } else if (msg.type === 'stream_done') {
        const imageAttachments = (msg.generatedImageUrls as string[] | undefined)?.map((url: string) => ({
          type: 'image' as const,
          data: url,
          name: url.split('/').pop() || 'generated-image.png',
          mimeType: url.endsWith('.jpg') || url.endsWith('.jpeg') ? 'image/jpeg'
                    : url.endsWith('.webp') ? 'image/webp'
                    : 'image/png',
        }));
        const fileAttachments = (msg.generatedFiles as Array<any> | undefined)?.map((f: any) => ({
          type: 'file' as const,
          data: f.url,
          name: f.name || (typeof f.url === 'string' ? f.url.split('/').pop() : 'download'),
          mimeType: f.mimeType || f.type || 'application/octet-stream',
        }));
        this.onResponse(msg.sessionId, {
          text: '',
          isDone: true,
          messageId: msg.messageId,
          attachments: [...(imageAttachments || []), ...(fileAttachments || [])],
        } as any);
      }
      // Handle other IPC message types (approval_request, execution_event, etc.)
    });

    child.on('exit', (code) => {
      console.log(`[AgentSupervisor] Agent for session ${sessionId} exited with code ${code}`);
      this.agents.delete(sessionId);
      this.sessionManager.setAgentPid(sessionId, null);
    });

    console.log(`[AgentSupervisor] Spawned agent for session ${sessionId} (PID: ${child.pid})`);
    return { process: child, sessionId, lastActive: new Date() };
  }

  private cleanupIdle(): void {
    const now = Date.now();
    for (const [sessionId, agent] of this.agents) {
      if (now - agent.lastActive.getTime() > this.idleTimeoutMs) {
        console.log(`[AgentSupervisor] Reclaiming idle agent for session ${sessionId}`);
        this.terminateAgent(sessionId, agent);
      }
    }
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Date.now();
    for (const [id, agent] of this.agents) {
      if (agent.lastActive.getTime() < oldestTime) {
        oldestTime = agent.lastActive.getTime();
        oldest = id;
      }
    }
    if (oldest) {
      const agent = this.agents.get(oldest)!;
      console.log(`[AgentSupervisor] Evicting oldest agent for session ${oldest}`);
      this.terminateAgent(oldest, agent);
    }
  }

  private terminateAgent(sessionId: string, agent: AgentProcess): void {
    try {
      agent.process.send({ type: 'shutdown' });
    } catch {
      // Process may already be disconnected
    }
    agent.process.kill('SIGTERM');
    this.agents.delete(sessionId);
    this.sessionManager.setAgentPid(sessionId, null);
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    for (const [sessionId, agent] of this.agents) {
      this.terminateAgent(sessionId, agent);
    }
    this.agents.clear();
  }

  getActiveCount(): number { return this.agents.size; }
  getMaxAgents(): number { return this.maxAgents; }

  private resolveAgentEntry(): string {
    const jsEntry = path.join(__dirname, '../agent/process.js');
    const tsEntry = path.join(__dirname, '../agent/process.ts');

    // Production (dist): prefer compiled JS and avoid ts-node runtime dependency.
    if (fs.existsSync(jsEntry)) return jsEntry;
    if (fs.existsSync(tsEntry)) return tsEntry;

    throw new Error(`Agent entry not found. Checked: ${jsEntry}, ${tsEntry}`);
  }

  private resolveAgentExecArgv(agentEntry: string): string[] {
    if (!agentEntry.endsWith('.ts')) return [];
    return ['-r', 'ts-node/register'];
  }
}
