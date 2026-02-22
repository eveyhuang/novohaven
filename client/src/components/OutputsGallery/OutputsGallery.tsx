import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import api, { OutputItem, OutputsResponse } from '../../services/api';
import { Card, CardBody, Button, Modal } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import { TranslationKey } from '../../i18n/translations';

type OutputCategory = 'all' | 'text' | 'markdown' | 'json' | 'images' | 'files';

export function OutputsGallery() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [outputs, setOutputs] = useState<OutputsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<OutputCategory>('all');
  const [selectedOutput, setSelectedOutput] = useState<OutputItem | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  useEffect(() => {
    loadOutputs();
  }, []);

  const loadOutputs = async () => {
    setIsLoading(true);
    try {
      const data = await api.getOutputs();
      setOutputs(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const categories: { key: OutputCategory; labelKey: TranslationKey; icon: string }[] = [
    { key: 'all', labelKey: 'allOutputs', icon: '📁' },
    { key: 'text', labelKey: 'textOutputs', icon: '📝' },
    { key: 'markdown', labelKey: 'markdownOutputs', icon: '📄' },
    { key: 'json', labelKey: 'jsonOutputs', icon: '{ }' },
    { key: 'images', labelKey: 'imageOutputs', icon: '🖼️' },
    { key: 'files', labelKey: 'fileOutputs', icon: '📎' },
  ];

  const getDisplayOutputs = (): OutputItem[] => {
    if (!outputs) return [];
    return outputs[activeCategory] || [];
  };

  const formatDate = (dateString: string): string => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const formatBytes = (bytes?: number): string => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileEmoji = (type: string): string => {
    const t = type.toLowerCase();
    if (t.includes('csv') || t.includes('excel') || t.includes('spreadsheet')) return '📊';
    if (t.includes('pdf')) return '📕';
    if (t.includes('image') || t.includes('png') || t.includes('jpg')) return '🖼️';
    if (t.includes('json')) return '{ }';
    if (t.includes('zip') || t.includes('archive')) return '📦';
    return '📄';
  };

  const truncateContent = (content: string, maxLength: number = 200): string => {
    if (!content) return '';
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  };

  const looksLikeCsv = (content: string): boolean => {
    const text = String(content || '').trim();
    if (!text) return false;
    if (text.startsWith('{') || text.startsWith('[')) return false;
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) return false;
    return lines[0].includes(',') && lines[1].includes(',');
  };

  const downloadContent = (output: OutputItem, format: 'txt' | 'md' | 'json' | 'csv') => {
    const content = output.content;
    const mimeTypes: Record<string, string> = {
      txt: 'text/plain',
      md: 'text/markdown',
      json: 'application/json',
      csv: 'text/csv',
    };

    const blob = new Blob([content], { type: mimeTypes[format] });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const fallbackName = `${output.stepName.replace(/\s+/g, '_')}_${output.id}.${format}`;
    link.download = output.fileName && output.fileName.toLowerCase().endsWith(`.${format}`)
      ? output.fileName
      : fallbackName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadFileOutput = (output: OutputItem) => {
    const isCsv = output.fileExtension === 'csv' || output.fileMimeType === 'text/csv' || looksLikeCsv(output.content);
    if (isCsv) {
      downloadContent(output, 'csv');
      return;
    }
    downloadContent(output, 'txt');
  };

  const downloadImage = (base64: string, mimeType: string, index: number) => {
    const link = document.createElement('a');
    link.href = `data:${mimeType};base64,${base64}`;
    link.download = `generated-image-${index + 1}.${mimeType.split('/')[1] || 'png'}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const openFullSizeImage = (base64: string, mimeType: string, index: number) => {
    const win = window.open();
    if (win) {
      win.document.write(`
        <html>
          <head><title>Generated Image ${index + 1}</title></head>
          <body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5;">
            <img src="data:${mimeType};base64,${base64}" style="max-width:100%;max-height:100vh;" />
          </body>
        </html>
      `);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const displayOutputs = getDisplayOutputs();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-secondary-900">{t('outputsGallery')}</h1>
        <p className="text-secondary-600 mt-1">{t('outputsGalleryDesc')}</p>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Category Tabs */}
      <div className="flex space-x-2 border-b border-secondary-200 pb-2">
        {categories.map((cat) => {
          const count = outputs?.[cat.key]?.length || 0;
          return (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`
                flex items-center space-x-2 px-4 py-2 rounded-t-lg text-sm font-medium transition-colors
                ${activeCategory === cat.key
                  ? 'bg-primary-50 text-primary-700 border-b-2 border-primary-600'
                  : 'text-secondary-600 hover:bg-secondary-100'
                }
              `}
            >
              <span>{cat.icon}</span>
              <span>{t(cat.labelKey)}</span>
              <span className={`
                px-2 py-0.5 text-xs rounded-full
                ${activeCategory === cat.key
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-secondary-100 text-secondary-600'
                }
              `}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Outputs Grid */}
      {displayOutputs.length === 0 ? (
        <Card>
          <CardBody className="text-center py-12">
            <p className="text-secondary-600">{t('noOutputsYet')}</p>
            <p className="text-sm text-secondary-500 mt-2">{t('noOutputsHint')}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayOutputs.map((output) => (
            <Card
              key={output.id}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => {
                setSelectedOutput(output);
                setShowDetailModal(true);
              }}
            >
              <CardBody className="space-y-3">
                {/* Header */}
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium text-secondary-900">{output.stepName}</h3>
                    <p className="text-sm text-secondary-500">{output.recipeName}</p>
                  </div>
                  <span className={`
                    px-2 py-1 text-xs font-medium rounded
                    ${output.generatedImages?.length
                      ? 'bg-purple-100 text-purple-700'
                      : output.manusFiles?.length
                      ? 'bg-orange-100 text-orange-700'
                      : output.outputFormat === 'file'
                      ? 'bg-orange-100 text-orange-700'
                      : output.outputFormat === 'json'
                      ? 'bg-blue-100 text-blue-700'
                      : output.outputFormat === 'markdown'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-secondary-100 text-secondary-700'
                    }
                  `}>
                    {output.generatedImages?.length ? t('image') : (output.manusFiles?.length || output.outputFormat === 'file') ? t('fileOutputs') : output.outputFormat}
                  </span>
                </div>

                {/* Preview */}
                {output.generatedImages && output.generatedImages.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    {output.generatedImages.slice(0, 4).map((img, idx) => (
                      <div key={idx} className="aspect-square bg-secondary-100 rounded overflow-hidden">
                        <img
                          src={`data:${img.mimeType};base64,${img.base64}`}
                          alt={`Generated ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                ) : output.manusFiles && output.manusFiles.length > 0 ? (
                  <div className="space-y-1.5">
                    {output.manusFiles.slice(0, 3).map((file, idx) => (
                      <div key={idx} className="flex items-center space-x-2 bg-secondary-50 rounded p-2">
                        <span className="text-lg">{getFileEmoji(file.type)}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-secondary-800 truncate">{file.name}</p>
                          <p className="text-xs text-secondary-500">{file.type}{file.size ? ` - ${formatBytes(file.size)}` : ''}</p>
                        </div>
                      </div>
                    ))}
                    {output.manusFiles.length > 3 && (
                      <p className="text-xs text-secondary-500">+{output.manusFiles.length - 3} more</p>
                    )}
                  </div>
                ) : (
                  <div className="bg-secondary-50 rounded p-3 text-sm text-secondary-700 max-h-24 overflow-hidden">
                    {output.outputFormat === 'json' ? (
                      <pre className="font-mono text-xs">{truncateContent(output.content, 150)}</pre>
                    ) : (
                      <p>{truncateContent(output.content, 150)}</p>
                    )}
                  </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between text-xs text-secondary-500">
                  <span>{output.aiModel}</span>
                  <span>{formatDate(output.executedAt)}</span>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* Detail Modal */}
      <Modal
        isOpen={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        title={selectedOutput?.stepName || t('outputDetails')}
        size="full"
      >
        {selectedOutput && (
          <div className="space-y-4">
            {/* Meta info */}
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-secondary-500">{t('recipe')}:</span>
                <span className="ml-2 font-medium">{selectedOutput.recipeName}</span>
              </div>
              <div>
                <span className="text-secondary-500">{t('model')}:</span>
                <span className="ml-2 font-medium">{selectedOutput.aiModel}</span>
              </div>
              <div>
                <span className="text-secondary-500">{t('executedAt')}:</span>
                <span className="ml-2 font-medium">{formatDate(selectedOutput.executedAt)}</span>
              </div>
            </div>

            {/* Content */}
            {selectedOutput.generatedImages && selectedOutput.generatedImages.length > 0 ? (
              <div>
                <h3 className="text-sm font-medium text-secondary-700 mb-3">{t('generatedImages')}</h3>
                <div className="grid grid-cols-2 gap-4">
                  {selectedOutput.generatedImages.map((img, idx) => (
                    <div key={idx} className="relative group">
                      <div className="bg-secondary-100 rounded-lg overflow-hidden">
                        <img
                          src={`data:${img.mimeType};base64,${img.base64}`}
                          alt={`Generated ${idx + 1}`}
                          className="w-full h-auto"
                        />
                      </div>
                      <div className="absolute bottom-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => openFullSizeImage(img.base64, img.mimeType, idx)}
                          className="px-3 py-1.5 bg-white/90 hover:bg-white text-secondary-700 text-sm rounded-lg shadow-sm"
                        >
                          {t('viewFullSize')}
                        </button>
                        <button
                          onClick={() => downloadImage(img.base64, img.mimeType, idx)}
                          className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg shadow-sm"
                        >
                          {t('downloadImage')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : selectedOutput.manusFiles && selectedOutput.manusFiles.length > 0 ? (
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-secondary-700">{t('fileOutputs')}</h3>
                <div className="space-y-2">
                  {selectedOutput.manusFiles.map((file, idx) => (
                    <a
                      key={idx}
                      href={file.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center space-x-3 p-3 bg-secondary-50 rounded-lg border border-secondary-200 hover:border-primary-300 hover:bg-primary-50 transition-colors"
                    >
                      <span className="text-2xl">{getFileEmoji(file.type)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-secondary-900">{file.name}</p>
                        <p className="text-xs text-secondary-500">{file.type}{file.size ? ` - ${formatBytes(file.size)}` : ''}</p>
                      </div>
                      <svg className="w-5 h-5 text-secondary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </a>
                  ))}
                </div>
                {selectedOutput.content && (
                  <div>
                    <h3 className="text-sm font-medium text-secondary-700 mb-2">{t('content')}</h3>
                    <div className="bg-secondary-50 rounded-lg p-4 max-h-96 overflow-auto">
                      <div className="prose prose-sm max-w-none">
                        <ReactMarkdown>{selectedOutput.content}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-secondary-700">{t('content')}</h3>
                  <div className="flex gap-2">
                    {selectedOutput.outputFormat === 'file' && (
                      <Button size="sm" variant="secondary" onClick={() => downloadFileOutput(selectedOutput)}>
                        {selectedOutput.fileExtension === 'csv' || selectedOutput.fileMimeType === 'text/csv' || looksLikeCsv(selectedOutput.content)
                          ? t('downloadCsv')
                          : t('downloadText')}
                      </Button>
                    )}
                    {selectedOutput.outputFormat === 'json' && (
                      <Button size="sm" variant="secondary" onClick={() => downloadContent(selectedOutput, 'json')}>
                        {t('downloadJson')}
                      </Button>
                    )}
                    {selectedOutput.outputFormat === 'markdown' && (
                      <Button size="sm" variant="secondary" onClick={() => downloadContent(selectedOutput, 'md')}>
                        {t('downloadMarkdown')}
                      </Button>
                    )}
                    {selectedOutput.outputFormat !== 'file' && (
                      <Button size="sm" variant="secondary" onClick={() => downloadContent(selectedOutput, 'txt')}>
                        {t('downloadText')}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="bg-secondary-50 rounded-lg p-4 max-h-96 overflow-auto">
                  {selectedOutput.outputFormat === 'markdown' ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown>{selectedOutput.content}</ReactMarkdown>
                    </div>
                  ) : selectedOutput.outputFormat === 'json' ? (
                    <pre className="text-sm font-mono whitespace-pre-wrap">
                      {(() => {
                        try {
                          return JSON.stringify(JSON.parse(selectedOutput.content), null, 2);
                        } catch {
                          return selectedOutput.content;
                        }
                      })()}
                    </pre>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{selectedOutput.content}</p>
                  )}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-between pt-4 border-t border-secondary-200">
              {selectedOutput.executionId > 0 ? (
                <Button
                  variant="ghost"
                  onClick={() => navigate(`/executions/${selectedOutput.executionId}`)}
                >
                  {t('viewExecution')}
                </Button>
              ) : (
                <span className="text-xs text-secondary-400">{selectedOutput.recipeName}</span>
              )}
              <Button variant="secondary" onClick={() => setShowDetailModal(false)}>
                {t('close')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
