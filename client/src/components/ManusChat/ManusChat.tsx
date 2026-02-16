import React, { useState, useEffect, useRef, useCallback } from 'react';
import Markdown from 'react-markdown';
import { ManusMessage, ManusFile } from '../../types';
import api from '../../services/api';
import { useLanguage } from '../../context/LanguageContext';

interface ManusChatProps {
  onComplete?: (result: { output: string; files?: ManusFile[]; creditsUsed?: number }) => void;
  onError?: (error: string) => void;
  initialPrompt?: string;
  initialUrls?: string[];
  taskId?: string;
  showPromptInput?: boolean;
  standalone?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user' | 'system';
  content: Array<{ type: string; text?: string; url?: string }>;
  timestamp?: string;
}

type TaskStatus = 'idle' | 'starting' | 'pending' | 'running' | 'stopped' | 'completed' | 'failed';

export function ManusChat({
  onComplete,
  onError,
  initialPrompt,
  initialUrls,
  taskId: externalTaskId,
  showPromptInput = false,
  standalone = false,
}: ManusChatProps) {
  const { t } = useLanguage();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [taskId, setTaskId] = useState<string | null>(externalTaskId || null);
  const [taskStatus, setTaskStatus] = useState<TaskStatus>(externalTaskId ? 'running' : 'idle');
  const [inputMessage, setInputMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [promptInput, setPromptInput] = useState(initialPrompt || '');
  const [completionFiles, setCompletionFiles] = useState<ManusFile[]>([]);
  const [creditsUsed, setCreditsUsed] = useState<number | undefined>();
  const [takeControlUrl, setTakeControlUrl] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenMessageIndices = useRef<Set<number>>(new Set());

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const connectStream = useCallback((tid: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = api.connectManusStream(tid);
    eventSourceRef.current = es;

    es.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        // Deduplicate: server sends _idx (position in Manus output array)
        const idx: number | undefined = data._idx;
        if (idx != null) {
          if (seenMessageIndices.current.has(idx)) return;
          seenMessageIndices.current.add(idx);
        }
        const chatMsg: ChatMessage = {
          id: idx != null ? `msg-${idx}` : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: data.role,
          content: data.content,
          timestamp: data.timestamp,
        };
        setMessages(prev => [...prev, chatMsg]);
      } catch (err) {
        console.error('[ManusChat] Failed to parse message event:', err);
      }
    });

    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log('[ManusChat] Status event:', data);

        if (data.status === 'completed' || data.status === 'failed') {
          setTaskStatus(data.status);
          setTakeControlUrl(null);
        } else if (data.stopReason === 'ask') {
          // Manus needs user intervention (CAPTCHA, verification, etc.)
          // Note: API status may still be "pending" — detection is content-based
          setTaskStatus('stopped');
          if (data.taskUrl) {
            setTakeControlUrl(data.taskUrl);
          }
        } else if (!data.stopReason) {
          // Normal running/pending state — map to our status
          if (data.status === 'running' || data.status === 'pending') {
            setTaskStatus(data.status);
          }
          // Clear take control when task resumes
          setTakeControlUrl(null);
        }
      } catch (err) {
        console.error('[ManusChat] Failed to parse status event:', err);
      }
    });

    es.addEventListener('take_control', (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log('[ManusChat] Take control event:', data);
        setTakeControlUrl(data.taskUrl);
        setTaskStatus('stopped');
      } catch (err) {
        console.error('[ManusChat] Failed to parse take_control event:', err);
      }
    });

    es.addEventListener('complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        setTaskStatus('completed');
        if (data.files?.length) {
          setCompletionFiles(data.files);
        }
        if (data.creditsUsed != null) {
          setCreditsUsed(data.creditsUsed);
        }
        es.close();
        onComplete?.({
          output: data.output || '',
          files: data.files,
          creditsUsed: data.creditsUsed,
        });
      } catch (err) {
        console.error('[ManusChat] Failed to parse complete event:', err);
      }
    });

    es.addEventListener('error', (e) => {
      if (e instanceof MessageEvent) {
        // Server sent an explicit error event (only sent on fatal give-up)
        try {
          const data = JSON.parse(e.data);
          setTaskStatus('failed');
          onError?.(data.error || 'Unknown error');
        } catch {
          // Non-JSON error event — ignore
        }
      }
      // Note: EventSource connection errors (non-MessageEvent) are handled
      // by the onerror handler below and auto-reconnect
    });

    es.onerror = () => {
      // Connection-level error — EventSource auto-reconnects, don't set failed
      console.warn('[ManusChat] SSE connection error, will retry...');
    };
  }, [onComplete, onError]);

  // Auto-start with initialPrompt
  useEffect(() => {
    if (initialPrompt && !taskId) {
      startTask(initialPrompt, initialUrls);
    }
  }, []); // intentionally run only on mount

  // Connect to existing task
  useEffect(() => {
    if (externalTaskId && !eventSourceRef.current) {
      connectStream(externalTaskId);
    }
  }, [externalTaskId, connectStream]);

  const startTask = async (prompt: string, urls?: string[]) => {
    setTaskStatus('starting');
    setMessages([]);
    setCompletionFiles([]);
    setCreditsUsed(undefined);
    setTakeControlUrl(null);
    seenMessageIndices.current.clear();
    try {
      const { taskId: newTaskId } = await api.startManusTask(prompt, urls);
      setTaskId(newTaskId);
      setTaskStatus('running');
      connectStream(newTaskId);
    } catch (err: any) {
      setTaskStatus('failed');
      onError?.(err.message || 'Failed to start task');
    }
  };

  const handleSendMessage = async () => {
    if (!taskId || !inputMessage.trim() || isSending) return;

    const text = inputMessage.trim();
    setInputMessage('');
    setIsSending(true);

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      await api.sendManusMessage(taskId, text);
    } catch (err: any) {
      onError?.(err.message || 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handlePromptSubmit = () => {
    if (!promptInput.trim()) return;
    startTask(promptInput.trim(), initialUrls);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handlePromptSubmit();
    }
  };

  const messageListStyle = standalone
    ? { minHeight: '400px' }
    : { maxHeight: '500px' };

  return (
    <div
      className={`flex flex-col border border-secondary-200 rounded-lg overflow-hidden bg-white ${
        standalone ? 'h-full' : ''
      }`}
      style={standalone ? undefined : { minHeight: '400px' }}
    >
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-secondary-50 border-b border-secondary-200">
        <div className="flex items-center space-x-2">
          <StatusDot status={taskStatus} />
          <span className="text-sm font-medium text-secondary-700">
            {t('manusChat.title')}
          </span>
        </div>
        <span className="text-xs text-secondary-500">
          {taskStatus === 'idle' && t('manusChat.ready')}
          {taskStatus === 'starting' && t('manusChat.starting')}
          {taskStatus === 'pending' && t('manusChat.taskStarted')}
          {taskStatus === 'running' && t('manusChat.taskRunning')}
          {taskStatus === 'stopped' && t('manusChat.waitingForUser')}
          {taskStatus === 'completed' && t('manusChat.taskCompleted')}
          {taskStatus === 'failed' && t('manusChat.taskFailed')}
        </span>
      </div>

      {/* Prompt input area (for standalone mode) */}
      {showPromptInput && taskStatus === 'idle' && (
        <div className="p-4 border-b border-secondary-200 bg-secondary-25">
          <textarea
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder={t('manusChat.enterPrompt')}
            rows={3}
            className="w-full px-3 py-2 border border-secondary-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 mb-2"
          />
          <button
            onClick={handlePromptSubmit}
            disabled={!promptInput.trim()}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('manusChat.startTask')}
          </button>
        </div>
      )}

      {/* Message list */}
      <div
        className={`flex-1 overflow-y-auto p-4 space-y-3 ${standalone ? '' : ''}`}
        style={messageListStyle}
      >
        {messages.length === 0 && taskStatus !== 'idle' && (
          <div className="flex items-center justify-center h-32 text-secondary-400 text-sm">
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-500"></div>
              <span>{t('manusChat.waitingForMessages')}</span>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} t={t} />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Take control banner — shown when Manus is waiting for user to solve CAPTCHA etc. */}
      {takeControlUrl && taskStatus === 'stopped' && (
        <div className="border-t border-secondary-200 p-3 bg-amber-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3 min-w-0">
              <div className="flex-shrink-0 w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-800">{t('manusChat.takeControlTitle')}</p>
                <p className="text-xs text-amber-600 mt-0.5">{t('manusChat.takeControlDesc')}</p>
              </div>
            </div>
            <a
              href={takeControlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 ml-3 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors inline-flex items-center space-x-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              <span>{t('manusChat.takeControl')}</span>
            </a>
          </div>
          <p className="text-xs text-amber-500 mt-2 flex items-center space-x-1">
            <svg className="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" /></svg>
            <span>{t('manusChat.willContinueAfterReply')}</span>
          </p>
        </div>
      )}

      {/* Input area (for replies) — show during running, pending, OR stopped (user can reply) */}
      {taskId && (taskStatus === 'running' || taskStatus === 'pending' || taskStatus === 'stopped') && (
        <div className="border-t border-secondary-200 p-3">
          <div className="flex items-center space-x-2">
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={taskStatus === 'stopped' ? t('manusChat.replyToResume') : t('manusChat.typeMessage')}
              disabled={isSending}
              className="flex-1 px-3 py-2 border border-secondary-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <button
              onClick={handleSendMessage}
              disabled={!inputMessage.trim() || isSending}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1"
            >
              {isSending ? (
                <span>{t('manusChat.sending')}</span>
              ) : (
                <span>{t('manusChat.send')}</span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Completion area with files and credits */}
      {taskStatus === 'completed' && (
        <div className="border-t border-secondary-200 p-3 bg-green-50 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-green-700 text-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>{t('manusChat.taskCompleted')}</span>
            </div>
            {creditsUsed != null && (
              <span className="text-xs text-secondary-500">
                {t('manusChat.creditsUsed')}: {creditsUsed}
              </span>
            )}
          </div>

          {/* File attachments */}
          {completionFiles.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-secondary-600">{t('manusChat.files')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {completionFiles.map((file, i) => (
                  <FileCard key={i} file={file} t={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {taskStatus === 'failed' && (
        <div className="border-t border-secondary-200 p-3 bg-red-50">
          <div className="flex items-center space-x-2 text-red-700 text-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>{t('manusChat.taskFailed')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  const colors: Record<TaskStatus, string> = {
    idle: 'bg-secondary-400',
    starting: 'bg-yellow-400 animate-pulse',
    pending: 'bg-yellow-400 animate-pulse',
    running: 'bg-blue-500 animate-pulse',
    stopped: 'bg-amber-500 animate-pulse',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
  };

  return <div className={`w-2 h-2 rounded-full ${colors[status]}`} />;
}

function FileCard({ file, t }: { file: ManusFile; t: (key: any) => string }) {
  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center space-x-3 p-2 bg-white rounded-lg border border-secondary-200 hover:border-primary-300 hover:bg-primary-50 transition-colors"
    >
      <div className="flex-shrink-0 w-8 h-8 bg-secondary-100 rounded flex items-center justify-center">
        <FileTypeIcon type={file.type} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-secondary-900 truncate">{file.name}</p>
        <p className="text-xs text-secondary-500">
          {file.type}{file.size ? ` - ${formatSize(file.size)}` : ''}
        </p>
      </div>
      <svg className="w-4 h-4 text-secondary-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
    </a>
  );
}

function FileTypeIcon({ type }: { type: string }) {
  const t = type.toLowerCase();
  if (t.includes('pdf')) {
    return <span className="text-red-500 text-xs font-bold">PDF</span>;
  }
  if (t.includes('csv') || t.includes('excel') || t.includes('spreadsheet')) {
    return <span className="text-green-600 text-xs font-bold">XLS</span>;
  }
  if (t.includes('image') || t.includes('png') || t.includes('jpg')) {
    return (
      <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 text-secondary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function MessageBubble({ message, t }: { message: ChatMessage; t: (key: any) => string }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="px-3 py-1 bg-secondary-100 rounded-full text-xs text-secondary-500">
          {extractText(message.content)}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2 ${
          isUser
            ? 'bg-primary-600 text-white'
            : 'bg-secondary-100 text-secondary-900'
        }`}
      >
        <ContentRenderer content={message.content} isUser={isUser} t={t} />
      </div>
    </div>
  );
}

// Check if text contains a markdown table (pipe-delimited)
function hasMarkdownTable(text: string): boolean {
  const lines = text.split('\n');
  let pipeLineCount = 0;
  for (const line of lines) {
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      pipeLineCount++;
      if (pipeLineCount >= 2) return true;
    } else {
      pipeLineCount = 0;
    }
  }
  return false;
}

function CopyTableButton({ text, t }: { text: string; t: (key: any) => string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // Extract table data as TSV for pasting into spreadsheets
    const lines = text.split('\n').filter(l => l.trim().startsWith('|'));
    const tsvLines = lines
      .filter(l => !l.match(/^\|\s*[-:]+/)) // skip separator rows
      .map(l =>
        l.split('|').slice(1, -1).map(cell => cell.trim()).join('\t')
      );
    navigator.clipboard.writeText(tsvLines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="mt-1 inline-flex items-center space-x-1 px-2 py-0.5 text-xs text-secondary-500 hover:text-secondary-700 hover:bg-secondary-200 rounded transition-colors"
    >
      {copied ? (
        <>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span>Copied!</span>
        </>
      ) : (
        <>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <span>{t('manusChat.copyTable')}</span>
        </>
      )}
    </button>
  );
}

function ContentRenderer({ content, isUser, t }: { content: Array<{ type: string; text?: string; url?: string }>; isUser: boolean; t: (key: any) => string }) {
  return (
    <>
      {content.map((block, i) => {
        if (block.type === 'text' || block.type === 'output_text') {
          const text = block.text || '';

          // For user messages, render plain text with linkification
          if (isUser) {
            return (
              <div key={i} className="text-sm whitespace-pre-wrap">
                <LinkifiedText text={text} isUser={isUser} />
              </div>
            );
          }

          // For assistant messages, render with markdown (tables, formatting, etc.)
          const showTableCopy = hasMarkdownTable(text);
          return (
            <div key={i} className="text-sm">
              <div className="prose prose-sm max-w-none prose-td:px-2 prose-td:py-1 prose-th:px-2 prose-th:py-1">
                <Markdown
                  components={{
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-2">
                        <table className="min-w-full border-collapse border border-secondary-300 text-sm">
                          {children}
                        </table>
                      </div>
                    ),
                    thead: ({ children }) => (
                      <thead className="bg-secondary-200">{children}</thead>
                    ),
                    th: ({ children }) => (
                      <th className="border border-secondary-300 px-3 py-1.5 text-left text-xs font-semibold text-secondary-700">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="border border-secondary-300 px-3 py-1.5 text-xs text-secondary-800">
                        {children}
                      </td>
                    ),
                    tr: ({ children }) => (
                      <tr className="even:bg-secondary-50">{children}</tr>
                    ),
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 underline"
                      >
                        {children}
                      </a>
                    ),
                    p: ({ children }) => (
                      <p className="mb-1 last:mb-0">{children}</p>
                    ),
                  }}
                >
                  {text}
                </Markdown>
              </div>
              {showTableCopy && <CopyTableButton text={text} t={t} />}
            </div>
          );
        }
        if (block.url) {
          return (
            <a
              key={i}
              href={block.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-block mt-1 px-3 py-1.5 rounded text-sm font-medium ${
                isUser
                  ? 'bg-white/20 text-white hover:bg-white/30'
                  : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
              }`}
            >
              {block.url}
            </a>
          );
        }
        return null;
      })}
    </>
  );
}

// Detect URLs in text and render as clickable links
function LinkifiedText({ text, isUser }: { text: string; isUser: boolean }) {
  const splitRegex = /(https?:\/\/[^\s<]+)/g;
  const testRegex = /^https?:\/\//;
  const parts = text.split(splitRegex);

  return (
    <>
      {parts.map((part, i) => {
        if (testRegex.test(part)) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className={`underline break-all ${
                isUser ? 'text-blue-200 hover:text-white' : 'text-blue-600 hover:text-blue-800'
              }`}
            >
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter(c => c.text)
    .map(c => c.text)
    .join(' ');
}

export default ManusChat;
