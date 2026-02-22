import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Button, Card, CardBody } from '../common';
import api from '../../services/api';

interface FileAttachment {
  type: string;
  data: string; // data URL or server URL
  name: string;
  mimeType: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  attachments?: FileAttachment[];
}

interface Session {
  id: string;
  title?: string;
  created_at: string;
  updated_at?: string;
}

export function AgentChat() {
  const { t } = useLanguage();

  // Session state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);

  // Model selection state
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [agentConfigId, setAgentConfigId] = useState<number>(1);

  // File attachment state
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadSessionMessages = useCallback(async (sessionId: string) => {
    try {
      const data = await api.getSession(sessionId);
      if (data.messages && Array.isArray(data.messages)) {
        const loaded: ChatMessage[] = data.messages
          .filter((m: any) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
          .map((m: any) => {
            let metadata: any = {};
            try { metadata = JSON.parse(m.metadata || '{}'); } catch {}

            const attachments: FileAttachment[] = [];

            if (m.role === 'user' && Array.isArray(metadata.attachments)) {
              metadata.attachments.forEach((a: any) => {
                attachments.push({
                  type: a.type || 'image',
                  data: a.url,
                  name: a.name || 'attachment',
                  mimeType: a.mimeType || 'image/png',
                });
              });
            }

            if (m.role === 'assistant' && Array.isArray(metadata.generatedImageUrls)) {
              metadata.generatedImageUrls.forEach((url: string) => {
                attachments.push({
                  type: 'image',
                  data: url,
                  name: url.split('/').pop() || 'generated-image.png',
                  mimeType: url.endsWith('.jpg') || url.endsWith('.jpeg') ? 'image/jpeg'
                            : url.endsWith('.webp') ? 'image/webp'
                            : 'image/png',
                });
              });
            }
            if (m.role === 'assistant' && Array.isArray(metadata.generatedFiles)) {
              metadata.generatedFiles.forEach((f: any) => {
                if (!f?.url) return;
                attachments.push({
                  type: 'file',
                  data: f.url,
                  name: f.name || (typeof f.url === 'string' ? f.url.split('/').pop() : 'download'),
                  mimeType: f.mimeType || f.type || 'application/octet-stream',
                });
              });
            }

            return {
              id: `db-${m.id || m.created_at}`,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              timestamp: m.created_at || new Date().toISOString(),
              attachments: attachments.length > 0 ? attachments : undefined,
            };
          });
        setMessages(loaded);
      }
    } catch {
      // Session may not be persisted yet (new local-only session)
      setMessages([]);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.getSessions();
      const sessionList: Session[] = (Array.isArray(data) ? data : []).map((s: any) => ({
        id: s.id,
        title: s.title || t('untitled'),
        created_at: s.created_at,
        updated_at: s.last_active_at,
      }));
      setSessions(sessionList);

      // Auto-select the most recent session and load its messages
      if (sessionList.length > 0) {
        setActiveSessionId((current) => {
          if (!current && sessionList.length > 0) {
            const mostRecent = sessionList[0];
            loadSessionMessages(mostRecent.id);
            return mostRecent.id;
          }
          return current;
        });
      }
    } catch {
      // Sessions may not exist yet
      setSessions([]);
    }
  }, [loadSessionMessages, t]);

  // Load sessions and model info on mount
  useEffect(() => {
    loadSessions();
    loadModelInfo();
  }, []);

  // Connect SSE when active session changes (unless already connected by ensureSSEConnected)
  useEffect(() => {
    if (!activeSessionId) return;

    // If ensureSSEConnected already set up this connection, skip
    if (eventSourceRef.current) return;

    ensureSSEConnected(activeSessionId);

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [activeSessionId]);

  const loadModelInfo = async () => {
    try {
      const [models, agents] = await Promise.all([
        api.getAvailableModels(),
        api.getAgents(),
      ]);
      setAvailableModels(models);
      if (agents.length > 0) {
        setAgentConfigId(agents[0].id);
        setCurrentModel(agents[0].default_model || '');
      }
    } catch {
      // Models may not be available yet
    }
  };

  const handleModelChange = async (modelId: string) => {
    const prevModel = currentModel;
    setCurrentModel(modelId);
    try {
      await api.updateAgent(agentConfigId, { default_model: modelId });
      // Start a fresh session so the new child process uses the correct provider
      if (activeSessionId) {
        startNewSession();
      }
    } catch {
      setCurrentModel(prevModel);
    }
  };

  const startNewSession = useCallback(() => {
    const sessionId = crypto.randomUUID();
    const newSession: Session = {
      id: sessionId,
      title: t('newChat'),
      created_at: new Date().toISOString(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(sessionId);
    setMessages([]);
    setInputText('');
    inputRef.current?.focus();
  }, [t]);

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setMessages([]);
    loadSessionMessages(sessionId);
  }, [loadSessionMessages]);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId);
    } catch {
      // Session may only exist locally
    }
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setMessages([]);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }
  }, [activeSessionId]);

  const clearAllSessions = useCallback(async () => {
    try {
      await api.deleteAllSessions();
    } catch {
      // Ignore
    }
    setSessions([]);
    setActiveSessionId(null);
    setMessages([]);
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Helper to ensure SSE is connected before sending a message
  const ensureSSEConnected = (sessionId: string): Promise<void> => {
    // If we already have an active SSE for this session, resolve immediately
    if (eventSourceRef.current && activeSessionId === sessionId) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // Close previous connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      const es = api.connectAgentStream(sessionId);
      eventSourceRef.current = es;

      const onFirstMessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'connected') {
            es.removeEventListener('message', onFirstMessage);
            resolve();
          }
        } catch {}
      };
      es.addEventListener('message', onFirstMessage);

      // Set up the normal SSE handler
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'connected') return;

          if (data.type === 'token' || data.type === 'chunk') {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              // Append to existing assistant message if it's from the same stream
              if (last && last.role === 'assistant' &&
                  (last.id === data.messageId || (!data.messageId && last.id.startsWith('assistant-')))) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + (data.content || data.token || ''), id: data.messageId || last.id },
                ];
              }
              return [
                ...prev,
                {
                  id: data.messageId || `assistant-${Date.now()}`,
                  role: 'assistant',
                  content: data.content || data.token || '',
                  timestamp: new Date().toISOString(),
                },
              ];
            });
            setStreaming(true);
          } else if (data.type === 'message') {
            // Complete message (non-streamed, e.g. error responses)
            setMessages((prev) => {
              // If the last message was streamed with this messageId, it's already there — skip
              const existing = prev.find((m) => m.id === data.messageId || m.id === data.id);
              if (existing) {
                return prev.map((m) =>
                  m.id === (data.messageId || data.id) ? { ...m, content: data.content || data.text } : m
                );
              }
              return [
                ...prev,
                {
                  id: data.messageId || data.id || `msg-${Date.now()}`,
                  role: data.role || 'assistant',
                  content: data.text || data.content,
                  timestamp: data.timestamp || new Date().toISOString(),
                },
              ];
            });
            setStreaming(false);
          } else if (data.type === 'done' || data.type === 'end') {
            setStreaming(false);
            if (Array.isArray(data.attachments) && data.attachments.length > 0) {
              const newAttachments: FileAttachment[] = data.attachments.map((a: any) => ({
                type: a.type || 'image',
                data: a.url,
                name: a.name || 'generated-image.png',
                mimeType: a.mimeType || 'image/png',
              }));
              setMessages((prev) => {
                const lastIdx = [...prev].reverse().findIndex(m => m.role === 'assistant');
                // If no assistant message exists yet for this turn, create a placeholder
                if (lastIdx === -1) {
                  return [
                    ...prev,
                    {
                      id: data.messageId || `assistant-img-${Date.now()}`,
                      role: 'assistant' as const,
                      content: '',
                      timestamp: new Date().toISOString(),
                      attachments: newAttachments,
                    },
                  ];
                }
                const idx = prev.length - 1 - lastIdx;
                const updated = [...prev];
                updated[idx] = {
                  ...updated[idx],
                  attachments: [...(updated[idx].attachments || []), ...newAttachments],
                };
                return updated;
              });
            }
          } else if (data.type === 'error') {
            setStreaming(false);
            setMessages((prev) => [
              ...prev,
              {
                id: `error-${Date.now()}`,
                role: 'assistant',
                content: `${t('error')}: ${data.message || t('somethingWentWrong')}`,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
        } catch {
          // Ignore parse errors
        }
      };

      es.onerror = () => {
        setStreaming(false);
      };

      // Timeout fallback — don't block forever
      setTimeout(resolve, 2000);
    });
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if ((!text && pendingFiles.length === 0) || sending || streaming) return;

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      const newSession: Session = {
        id: sessionId,
        title: text.slice(0, 50),
        created_at: new Date().toISOString(),
      };
      setSessions((prev) => [newSession, ...prev]);
      setActiveSessionId(sessionId);
    } else {
      // Update session title if it's still the localized "New Chat"
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId && (s.title === 'New Chat' || s.title === t('newChat'))
            ? { ...s, title: text.slice(0, 50) }
            : s
        )
      );
    }

    // Capture and clear attachments before sending
    const attachments = pendingFiles.length > 0 ? [...pendingFiles] : undefined;

    // Add user message to UI immediately
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      attachments,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setPendingFiles([]);
    setSending(true);
    setStreaming(true);

    try {
      // Ensure SSE is connected before sending (fixes first-message race)
      await ensureSSEConnected(sessionId);
      await api.sendAgentMessage(sessionId, text, attachments);
    } catch (err: any) {
      setStreaming(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `${t('failedToSendMessage')}: ${err.message || t('unknownError')}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPendingFiles((prev) => [
          ...prev,
          {
            type: file.type.startsWith('image/') ? 'image' : 'file',
            data: dataUrl,
            name: file.name,
            mimeType: file.type,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });

    // Reset input so the same file can be selected again
    e.target.value = '';
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] bg-white rounded-lg border border-secondary-200 shadow-sm overflow-hidden">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="w-64 flex-shrink-0 border-r border-secondary-200 bg-secondary-50 flex flex-col">
          {/* Sidebar Header */}
          <div className="p-3 border-b border-secondary-200 space-y-2">
            <Button
              onClick={startNewSession}
              className="w-full"
            >
              + {t('newChat')}
            </Button>
            {sessions.length > 0 && (
              <button
                onClick={clearAllSessions}
                className="w-full text-xs text-secondary-400 hover:text-red-500 transition-colors py-1"
              >
                {t('clearAllChats')}
              </button>
            )}
          </div>

          {/* Session List */}
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 && (
              <p className="text-sm text-secondary-400 p-4 text-center">
                {t('noConversationsYet')}
              </p>
            )}
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`group flex items-center border-b border-secondary-100 transition-colors ${
                  session.id === activeSessionId
                    ? 'bg-primary-50 text-primary-700 font-medium'
                    : 'text-secondary-700 hover:bg-secondary-100'
                }`}
              >
                <button
                  onClick={() => selectSession(session.id)}
                  className="flex-1 text-left px-3 py-2.5 text-sm truncate min-w-0"
                >
                  <div className="truncate">{session.title || t('untitled')}</div>
                  <div className="text-xs text-secondary-400 mt-0.5">
                    {formatTime(session.created_at)}
                  </div>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 mr-1 text-secondary-400 hover:text-red-500 transition-all flex-shrink-0"
                  title={t('deleteChat')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat Header */}
        <div className="px-4 py-3 border-b border-secondary-200 bg-secondary-50 flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-secondary-500 hover:text-secondary-700 p-1"
            title={t('toggleSidebar')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h2 className="text-lg font-semibold text-secondary-900">
            {t('agentChat')}
          </h2>
          {availableModels.length > 0 && (
            <select
              value={currentModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="ml-2 text-xs border border-secondary-300 rounded px-2 py-1 bg-white text-secondary-700
                focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              title={t('selectModel')}
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          )}
          {streaming && (
            <span className="text-xs text-primary-600 animate-pulse ml-auto">
              {t('aiThinking')}
            </span>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!activeSessionId && messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-secondary-400">
                <p className="text-lg mb-2">{t('startConversation')}</p>
                <p className="text-sm">{t('chatEmptyHint')}</p>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[75%] rounded-lg px-4 py-2.5 ${
                  msg.role === 'user'
                    ? 'bg-primary-600 text-white'
                    : 'bg-secondary-100 text-secondary-900'
                }`}
              >
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {msg.attachments.filter(a => a.type === 'image').map((a, i) => (
                      <div key={i} className="relative group">
                        <img
                          src={a.data}
                          alt={a.name}
                          className="max-w-[300px] max-h-[300px] rounded object-contain border border-white/20 bg-black/10"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                        <a
                          href={a.data}
                          download={a.name || 'image.png'}
                          className={`absolute bottom-1.5 right-1.5 flex items-center justify-center w-7 h-7 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity ${msg.role === 'user' ? 'bg-primary-800 text-white' : 'bg-white text-secondary-700 border border-secondary-200'}`}
                          title={t('downloadImage')}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </a>
                      </div>
                    ))}
                    {msg.attachments.filter(a => a.type !== 'image').map((a, i) => (
                      <a
                        key={i}
                        href={a.data}
                        download={a.name || 'download'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs bg-white/20 rounded px-2 py-1 underline"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                        {a.name}
                      </a>
                    ))}
                  </div>
                )}
                <div className="whitespace-pre-wrap break-words text-sm">
                  {msg.content}
                </div>
                <div
                  className={`text-xs mt-1 ${
                    msg.role === 'user' ? 'text-primary-200' : 'text-secondary-400'
                  }`}
                >
                  {formatTime(msg.timestamp)}
                </div>
              </div>
            </div>
          ))}

          {streaming && messages.length > 0 && messages[messages.length - 1]?.role !== 'assistant' && (
            <div className="flex justify-start">
              <div className="bg-secondary-100 rounded-lg px-4 py-2.5">
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-secondary-400 rounded-full animate-bounce" />
                  <div className="w-2 h-2 bg-secondary-400 rounded-full animate-bounce [animation-delay:0.1s]" />
                  <div className="w-2 h-2 bg-secondary-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-secondary-200 p-3 bg-white">
          {/* Pending file previews */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {pendingFiles.map((file, i) => (
                <div key={i} className="relative group">
                  {file.type === 'image' ? (
                    <img
                      src={file.data}
                      alt={file.name}
                      className="w-16 h-16 rounded object-cover border border-secondary-200"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded border border-secondary-200 bg-secondary-50 flex items-center justify-center">
                      <svg className="w-6 h-6 text-secondary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                  )}
                  <button
                    onClick={() => removePendingFile(i)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center
                      text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    &times;
                  </button>
                  <div className="text-[10px] text-secondary-400 truncate w-16 mt-0.5">{file.name}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.txt,.csv,.json"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2 text-secondary-400 hover:text-secondary-600 transition-colors flex-shrink-0"
              title={t('attachFiles')}
              disabled={sending}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            </button>
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('chatInputPlaceholder')}
              rows={1}
              className="flex-1 resize-none rounded-lg border border-secondary-300 px-3 py-2 text-sm
                focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500
                placeholder-secondary-400 max-h-32"
              style={{ minHeight: '40px' }}
              disabled={sending}
            />
            <Button
              onClick={handleSend}
              disabled={(!inputText.trim() && pendingFiles.length === 0) || sending || streaming}
            >
              {sending ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
