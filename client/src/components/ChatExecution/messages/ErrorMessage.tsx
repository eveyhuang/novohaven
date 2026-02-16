import React from 'react';
import { ExecutionChatMessage } from '../../../types';

interface ErrorMessageProps {
  message: ExecutionChatMessage;
  onRetry?: (stepExecutionId: number) => void;
}

const ErrorMessage: React.FC<ErrorMessageProps> = ({ message, onRetry }) => {
  const stepExecutionId = message.metadata?.stepExecutionId;

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] px-4 py-3 bg-red-50 border border-red-200 rounded-lg">
        <div className="flex items-start gap-2">
          <span className="text-red-500 mt-0.5">&#9888;</span>
          <div className="flex-1">
            <p className="text-sm text-red-700">{message.content}</p>
            {stepExecutionId && onRetry && (
              <button
                onClick={() => onRetry(stepExecutionId)}
                className="mt-2 px-3 py-1 text-xs font-medium text-red-600 bg-red-100 hover:bg-red-200 rounded-md transition-colors"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ErrorMessage;
