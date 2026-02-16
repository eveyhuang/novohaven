import { EventEmitter } from 'events';
import { ExecutionChatMessage } from '../types';
import { v4 as uuidv4 } from 'uuid';

type MessageCallback = (message: ExecutionChatMessage) => void;

class ExecutionEventEmitter {
  private emitter = new EventEmitter();
  private activeExecutions = new Set<number>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  createMessage(
    partial: Omit<ExecutionChatMessage, 'id' | 'timestamp'>
  ): ExecutionChatMessage {
    return {
      ...partial,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };
  }

  emit(executionId: number, message: ExecutionChatMessage): void {
    this.activeExecutions.add(executionId);
    this.emitter.emit(`execution:${executionId}`, message);
  }

  subscribe(executionId: number, callback: MessageCallback): void {
    this.emitter.on(`execution:${executionId}`, callback);
  }

  unsubscribe(executionId: number, callback: MessageCallback): void {
    this.emitter.off(`execution:${executionId}`, callback);
  }

  cleanup(executionId: number): void {
    this.emitter.removeAllListeners(`execution:${executionId}`);
    this.activeExecutions.delete(executionId);
  }

  isActive(executionId: number): boolean {
    return this.activeExecutions.has(executionId);
  }
}

// Singleton instance
export const executionEvents = new ExecutionEventEmitter();
export { ExecutionEventEmitter };
