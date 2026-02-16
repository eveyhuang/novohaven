import React from 'react';
import { ExecutionChatMessage } from '../../../types';

interface UserMessageProps {
  message: ExecutionChatMessage;
}

const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] px-4 py-3 bg-primary-600 text-white rounded-2xl rounded-br-sm">
        <p className="text-sm whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
};

export default UserMessage;
