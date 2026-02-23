import React, { useEffect, useState, useCallback } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Button, Card, CardBody, Input } from '../common';
import api from '../../services/api';

interface PluginConfigSchema {
  type?: string;
  properties?: Record<string, {
    type: string;
    description?: string;
    default?: unknown;
  }>;
}

interface Plugin {
  name: string;
  type: 'channel' | 'tool' | 'memory' | 'provider';
  version: string;
  displayName: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  configSchema: PluginConfigSchema;
}

const TYPE_COLORS: Record<string, string> = {
  channel: 'bg-blue-100 text-blue-800',
  tool: 'bg-green-100 text-green-800',
  memory: 'bg-purple-100 text-purple-800',
  provider: 'bg-orange-100 text-orange-800',
};

export function PluginManager() {
  const { t } = useLanguage();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const [editedConfigs, setEditedConfigs] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getPlugins();
      setPlugins(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('failedToLoadPlugins');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  const handleToggleEnabled = async (plugin: Plugin) => {
    try {
      await api.updatePlugin(plugin.name, {
        enabled: !plugin.enabled,
        config: plugin.config,
      });
      setPlugins((prev) =>
        prev.map((p) =>
          p.name === plugin.name ? { ...p, enabled: !p.enabled } : p
        )
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('failedToUpdatePlugin');
      setError(message);
    }
  };

  const handleExpand = (pluginName: string) => {
    if (expandedPlugin === pluginName) {
      setExpandedPlugin(null);
    } else {
      setExpandedPlugin(pluginName);
      const plugin = plugins.find((p) => p.name === pluginName);
      if (plugin && !editedConfigs[pluginName]) {
        setEditedConfigs((prev) => ({
          ...prev,
          [pluginName]: { ...plugin.config },
        }));
      }
    }
  };

  const handleConfigChange = (pluginName: string, key: string, value: unknown) => {
    setEditedConfigs((prev) => ({
      ...prev,
      [pluginName]: {
        ...(prev[pluginName] || {}),
        [key]: value,
      },
    }));
  };

  const handleSaveConfig = async (plugin: Plugin) => {
    const config = editedConfigs[plugin.name];
    if (!config) return;

    try {
      setSaving(plugin.name);
      await api.updatePlugin(plugin.name, {
        enabled: plugin.enabled,
        config,
      });
      setPlugins((prev) =>
        prev.map((p) =>
          p.name === plugin.name ? { ...p, config: { ...config } } : p
        )
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('failedToSaveConfig');
      setError(message);
    } finally {
      setSaving(null);
    }
  };

  const renderConfigForm = (plugin: Plugin) => {
    const schema = plugin.configSchema;
    if (!schema?.properties || Object.keys(schema.properties).length === 0) {
      return (
        <p className="text-sm text-gray-500 italic">{t('noConfigurableProperties')}</p>
      );
    }

    const currentConfig = editedConfigs[plugin.name] || plugin.config || {};

    return (
      <div className="space-y-4">
        {Object.entries(schema.properties).map(([key, prop]) => {
          const value = currentConfig[key] ?? prop.default ?? '';

          if (prop.type === 'boolean') {
            return (
              <label key={key} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!value}
                  onChange={(e) =>
                    handleConfigChange(plugin.name, key, e.target.checked)
                  }
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <span className="text-sm font-medium text-gray-700">{key}</span>
                  {prop.description && (
                    <p className="text-xs text-gray-500">{prop.description}</p>
                  )}
                </div>
              </label>
            );
          }

          // Default: render as text input for string, number, etc.
          return (
            <div key={key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {key}
                {prop.description && (
                  <span className="ml-2 text-xs text-gray-400 font-normal">
                    {prop.description}
                  </span>
                )}
              </label>
              <Input
                value={String(value)}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  handleConfigChange(plugin.name, key, e.target.value)
                }
              />
            </div>
          );
        })}

        <div className="pt-2">
          <Button
            onClick={() => handleSaveConfig(plugin)}
            disabled={saving === plugin.name}
          >
            {saving === plugin.name ? t('saving') : t('saveConfig')}
          </Button>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500">{t('loadingPlugins')}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('pluginManager')}</h1>
        <Button onClick={fetchPlugins}>{t('refresh')}</Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
        </div>
      )}

      {plugins.length === 0 ? (
        <p className="text-gray-500 text-center py-8">{t('noPluginsRegistered')}</p>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => (
            <Card key={plugin.name}>
              <CardBody>
                {/* Plugin row */}
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => handleExpand(plugin.name)}
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 truncate">
                          {plugin.displayName || plugin.name}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            TYPE_COLORS[plugin.type] || 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {plugin.type}
                        </span>
                        <span className="text-xs text-gray-400">v{plugin.version}</span>
                      </div>
                      {plugin.description && (
                        <p className="text-sm text-gray-500 mt-0.5 truncate">
                          {plugin.description}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 ml-4">
                    {/* Toggle switch */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleEnabled(plugin);
                      }}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        plugin.enabled ? 'bg-blue-600' : 'bg-gray-300'
                      }`}
                      aria-label={plugin.enabled ? t('disablePlugin') : t('enablePlugin')}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          plugin.enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>

                    {/* Expand indicator */}
                    <svg
                      className={`w-5 h-5 text-gray-400 transition-transform ${
                        expandedPlugin === plugin.name ? 'rotate-180' : ''
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </div>
                </div>

                {/* Expanded config form */}
                {expandedPlugin === plugin.name && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    {renderConfigForm(plugin)}
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
