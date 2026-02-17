/**
 * Agent child process entry point.
 *
 * Spawned by AgentSupervisor via child_process.fork().
 * Hosts an AgentRunner instance and communicates with the
 * gateway via IPC (process.send / process.on('message')).
 */
import { AgentRunner } from './AgentRunner';

const sessionId = process.env.SESSION_ID!;
if (!sessionId) {
  console.error('[Agent] No SESSION_ID environment variable set');
  process.exit(1);
}

const runner = new AgentRunner(sessionId);

process.on('message', async (msg: any) => {
  switch (msg.type) {
    case 'message':
      try {
        await runner.handleTurn(msg.message);
      } catch (err: any) {
        process.send!({
          type: 'error',
          sessionId,
          error: err.message,
        });
      }
      break;

    case 'approval_response':
      runner.handleApprovalResponse(msg.requestId, msg.approved, msg.data);
      break;

    case 'shutdown':
      await runner.shutdown();
      process.exit(0);
      break;
  }
});

// Heartbeat — lets the supervisor know we're alive
setInterval(() => {
  process.send!({ type: 'heartbeat', sessionId });
}, 30_000);

console.log(`[Agent] Process started for session ${sessionId} (PID: ${process.pid})`);
