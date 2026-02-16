import React, { useEffect, useRef } from 'react';
import { ExecutionChatMessage } from '../../types';
import StepHeaderMessage from './messages/StepHeaderMessage';
import SystemMessage from './messages/SystemMessage';
import AgentMessage from './messages/AgentMessage';
import UserMessage from './messages/UserMessage';
import OutputMessage from './messages/OutputMessage';
import ErrorMessage from './messages/ErrorMessage';
import ActionMessage from './messages/ActionMessage';

interface ChatMessageListProps {
  messages: ExecutionChatMessage[];
  onApprove?: (stepExecutionId: number) => void;
  onReject?: (stepExecutionId: number) => void;
  onRetry?: (stepExecutionId: number) => void;
  actionDisabled?: boolean;
  stepRefs: React.MutableRefObject<Record<number, HTMLDivElement | null>>;
}

const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages,
  onApprove,
  onReject,
  onRetry,
  actionDisabled,
  stepRefs,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const renderMessage = (message: ExecutionChatMessage) => {
    switch (message.type) {
      case 'step-start':
        return <StepHeaderMessage message={message} />;
      case 'progress':
        return <SystemMessage message={message} />;
      case 'agent-message':
        return <AgentMessage message={message} />;
      case 'user-message':
        return <UserMessage message={message} />;
      case 'step-output':
        return <OutputMessage message={message} />;
      case 'step-error':
        return <ErrorMessage message={message} onRetry={onRetry} />;
      case 'action-required':
        return (
          <ActionMessage
            message={message}
            onApprove={onApprove}
            onReject={onReject}
            disabled={actionDisabled}
          />
        );
      case 'step-approved':
      case 'step-rejected':
      case 'execution-complete':
        return <SystemMessage message={message} />;
      default:
        return <SystemMessage message={message} />;
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((message) => (
        <div
          key={message.id}
          ref={
            message.type === 'step-start'
              ? (el) => { stepRefs.current[message.stepOrder] = el; }
              : undefined
          }
        >
          {renderMessage(message)}
        </div>
      ))}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatMessageList;
