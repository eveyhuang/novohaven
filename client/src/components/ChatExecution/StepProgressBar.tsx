import React from 'react';
import { StepExecution, StepExecutionStatus } from '../../types';

interface StepProgressBarProps {
  steps: StepExecution[];
  currentStep: number;
  totalSteps: number;
  onStepClick: (stepOrder: number) => void;
}

const statusColors: Record<StepExecutionStatus | string, string> = {
  pending: 'bg-secondary-300',
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  awaiting_review: 'bg-purple-500',
};

const StepProgressBar: React.FC<StepProgressBarProps> = ({
  steps,
  currentStep,
  totalSteps,
  onStepClick,
}) => {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-secondary-200">
      <span className="text-sm font-medium text-secondary-600 whitespace-nowrap">
        Step {currentStep} of {totalSteps}
      </span>
      <div className="flex items-center gap-1.5">
        {steps.map((step) => (
          <button
            key={step.id}
            onClick={() => onStepClick(step.step_order)}
            className="group relative"
            title={step.step_name || `Step ${step.step_order}`}
          >
            <div
              className={`w-3 h-3 rounded-full transition-transform group-hover:scale-125 ${
                statusColors[step.status] || statusColors.pending
              }`}
            />
          </button>
        ))}
      </div>
    </div>
  );
};

export default StepProgressBar;
