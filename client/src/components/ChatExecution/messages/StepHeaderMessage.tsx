import React from 'react';
import { ExecutionChatMessage } from '../../../types';

const stepTypeIcons: Record<string, string> = {
  ai: '&#129302;',
  scraping: '&#127760;',
  manus: '&#129504;',
  script: '&#128220;',
  http: '&#127760;',
  transform: '&#128260;',
};

interface StepHeaderMessageProps {
  message: ExecutionChatMessage;
}

const StepHeaderMessage: React.FC<StepHeaderMessageProps> = ({ message }) => {
  const icon = stepTypeIcons[message.stepType] || '&#9654;';

  return (
    <div className="flex items-center gap-2 py-3">
      <div className="flex-1 h-px bg-secondary-200" />
      <span className="px-3 py-1 text-xs font-semibold text-secondary-500 bg-secondary-100 rounded-full whitespace-nowrap">
        <span dangerouslySetInnerHTML={{ __html: icon }} />{' '}
        Step {message.stepOrder}: {message.stepName}
      </span>
      <div className="flex-1 h-px bg-secondary-200" />
    </div>
  );
};

export default StepHeaderMessage;
