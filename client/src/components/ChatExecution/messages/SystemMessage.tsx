import React from 'react';
import { ExecutionChatMessage } from '../../../types';

interface SystemMessageProps {
  message: ExecutionChatMessage;
}

const SystemMessage: React.FC<SystemMessageProps> = ({ message }) => {
  return (
    <div className="flex justify-center py-1">
      <span className="px-3 py-1 text-xs text-secondary-500 bg-secondary-50 rounded-full">
        {message.content}
      </span>
    </div>
  );
};

export default SystemMessage;
