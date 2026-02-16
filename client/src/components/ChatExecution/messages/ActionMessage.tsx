import React from 'react';
import { ExecutionChatMessage } from '../../../types';

interface ActionMessageProps {
  message: ExecutionChatMessage;
  onApprove?: (stepExecutionId: number) => void;
  onReject?: (stepExecutionId: number) => void;
  disabled?: boolean;
}

const ActionMessage: React.FC<ActionMessageProps> = ({
  message,
  onApprove,
  onReject,
  disabled,
}) => {
  const stepExecutionId = message.metadata?.stepExecutionId;
  const actionType = message.metadata?.actionType;

  if (actionType === 'captcha') {
    return (
      <div className="flex justify-center py-2">
        <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-center">
          <p className="text-sm text-amber-700 font-medium mb-2">
            CAPTCHA detected - manual resolution required
          </p>
          {message.metadata?.debuggerUrl && (
            <a
              href={message.metadata.debuggerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-100 hover:bg-amber-200 rounded-md transition-colors"
            >
              Open Debugger
            </a>
          )}
        </div>
      </div>
    );
  }

  if (actionType === 'take-control') {
    return (
      <div className="flex justify-center py-2">
        <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-center">
          <p className="text-sm text-amber-700">
            Agent needs your input. Take control to assist.
          </p>
        </div>
      </div>
    );
  }

  // Default: approve/reject
  return (
    <div className="flex justify-center py-2">
      <div className="px-4 py-3 bg-purple-50 border border-purple-200 rounded-lg text-center">
        <p className="text-sm text-purple-700 mb-3">{message.content}</p>
        {stepExecutionId && (
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => onApprove?.(stepExecutionId)}
              disabled={disabled}
              className="px-4 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded-md transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => onReject?.(stepExecutionId)}
              disabled={disabled}
              className="px-4 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 rounded-md transition-colors"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ActionMessage;
