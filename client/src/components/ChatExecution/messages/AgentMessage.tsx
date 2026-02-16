import React from 'react';
import ReactMarkdown from 'react-markdown';
import { ExecutionChatMessage } from '../../../types';

interface AgentMessageProps {
  message: ExecutionChatMessage;
}

const AgentMessage: React.FC<AgentMessageProps> = ({ message }) => {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] px-4 py-3 bg-secondary-100 rounded-2xl rounded-bl-sm">
        <div className="text-xs text-secondary-400 mb-1 font-medium">
          {message.stepName}
        </div>
        <div className="prose prose-sm max-w-none text-secondary-800 [&_table]:border-collapse [&_td]:border [&_td]:border-secondary-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-secondary-300 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-secondary-200">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
};

export default AgentMessage;
