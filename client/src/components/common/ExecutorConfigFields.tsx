import React from 'react';
import { Input, TextArea, Select } from './Input';
import { ExecutorInfo } from '../../services/api';

/**
 * Renders dynamic form fields based on an executor's config schema.
 * Used inline within step editors (RecipeBuilder, RecipeRunner, TemplateEditor)
 * for non-AI step types like script, http, transform, etc.
 */
export function ExecutorConfigFields({
  stepType,
  executors,
  executorConfig,
  onConfigChange,
}: {
  stepType: string;
  executors: ExecutorInfo[];
  executorConfig: string;
  onConfigChange: (config: string) => void;
}) {
  const executor = executors.find(e => e.type === stepType);
  if (!executor) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <p className="text-sm text-yellow-700">
          No configuration schema found for step type "{stepType}".
        </p>
      </div>
    );
  }

  let config: Record<string, any> = {};
  try {
    config = executorConfig ? JSON.parse(executorConfig) : {};
  } catch {
    config = {};
  }

  const updateField = (name: string, value: any) => {
    const updated = { ...config, [name]: value };
    onConfigChange(JSON.stringify(updated));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-2 mb-2">
        <span className="text-2xl">{executor.icon}</span>
        <div>
          <h4 className="font-medium text-secondary-900">{executor.displayName}</h4>
          <p className="text-sm text-secondary-500">{executor.description}</p>
        </div>
      </div>

      {executor.configSchema.fields.map((field) => {
        const value = config[field.name] ?? field.defaultValue ?? '';

        switch (field.type) {
          case 'select':
            return (
              <Select
                key={field.name}
                label={field.label}
                value={value}
                onChange={(e) => updateField(field.name, e.target.value)}
                options={field.options || []}
              />
            );

          case 'textarea':
            return (
              <div key={field.name}>
                <TextArea
                  label={field.label}
                  value={value}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  rows={6}
                  className="font-mono text-sm"
                />
                {field.helpText && (
                  <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                )}
              </div>
            );

          case 'code':
            return (
              <div key={field.name}>
                <label className="block text-sm font-medium text-secondary-700 mb-1">
                  {field.label}
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </label>
                <textarea
                  value={value}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  rows={12}
                  className="w-full px-3 py-2 border border-secondary-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm bg-secondary-50"
                  placeholder={`Enter ${field.language || 'code'} here...`}
                />
                {field.helpText && (
                  <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                )}
              </div>
            );

          case 'number':
            return (
              <Input
                key={field.name}
                label={field.label}
                type="number"
                value={value}
                onChange={(e) => updateField(field.name, parseInt(e.target.value) || 0)}
              />
            );

          case 'json':
            return (
              <div key={field.name}>
                <label className="block text-sm font-medium text-secondary-700 mb-1">
                  {field.label}
                </label>
                <textarea
                  value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                  onChange={(e) => {
                    try {
                      updateField(field.name, JSON.parse(e.target.value));
                    } catch {
                      const updated = { ...config, [field.name]: e.target.value };
                      onConfigChange(JSON.stringify(updated));
                    }
                  }}
                  rows={4}
                  className="w-full px-3 py-2 border border-secondary-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm"
                  placeholder='{"key": "value"}'
                />
                {field.helpText && (
                  <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                )}
              </div>
            );

          case 'boolean':
            return (
              <div key={field.name} className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={!!value}
                  onChange={(e) => updateField(field.name, e.target.checked)}
                  className="rounded border-secondary-300 text-primary-600 focus:ring-primary-500"
                />
                <label className="text-sm font-medium text-secondary-700">{field.label}</label>
              </div>
            );

          default: // 'text'
            return (
              <div key={field.name}>
                <Input
                  label={field.label}
                  value={value}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  placeholder={field.helpText || ''}
                />
                {field.helpText && (
                  <p className="mt-1 text-sm text-secondary-500">{field.helpText}</p>
                )}
              </div>
            );
        }
      })}
    </div>
  );
}
