import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Button, Card, CardBody } from '../common';
import api from '../../services/api';

interface FileAttachment {
  type: string;
  data: string; // base64 data URL
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

  const loadSessions = async () => {
    try {
      const data = await api.getSessions();
      setSessions(Array.isArray(data) ? data : []);
    } catch {
      // Sessions may not exist yet
      setSessions([]);
    }
  };

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
      title: 'New Chat',
      created_at: new Date().toISOString(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(sessionId);
    setMessages([]);
    setInputText('');
    inputRef.current?.focus();
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setMessages([]);
    // Messages will be loaded via SSE connection or could be fetched separately
  }, []);

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
          } else if (data.type === 'error') {
            setStreaming(false);
            setMessages((prev) => [
              ...prev,
              {
                id: `error-${Date.now()}`,
                role: 'assistant',
                content: `Error: ${data.message || 'Something went wrong'}`,
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
      // Update session title if it's still "New Chat"
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId && s.title === 'New Chat'
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
          content: `Failed to send message: ${err.message || 'Unknown error'}`,
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
              + New Chat
            </Button>
            {sessions.length > 0 && (
              <button
                onClick={clearAllSessions}
                className="w-full text-xs text-secondary-400 hover:text-red-500 transition-colors py-1"
              >
                Clear all chats
              </button>
            )}
          </div>

          {/* Session List */}
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 && (
              <p className="text-sm text-secondary-400 p-4 text-center">
                No conversations yet
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
                  <div className="truncate">{session.title || 'Untitled'}</div>
                  <div className="text-xs text-secondary-400 mt-0.5">
                    {formatTime(session.created_at)}
                  </div>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 mr-1 text-secondary-400 hover:text-red-500 transition-all flex-shrink-0"
                  title="Delete chat"
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
            title="Toggle sidebar"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h2 className="text-lg font-semibold text-secondary-900">
            Agent Chat
          </h2>
          {availableModels.length > 0 && (
            <select
              value={currentModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="ml-2 text-xs border border-secondary-300 rounded px-2 py-1 bg-white text-secondary-700
                focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              title="Select LLM provider model"
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
              Thinking...
            </span>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!activeSessionId && messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-secondary-400">
                <p className="text-lg mb-2">Start a conversation</p>
                <p className="text-sm">Type a message below or create a new chat session</p>
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
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {msg.attachments.filter(a => a.type === 'image').map((a, i) => (
                      <img
                        key={i}
                        src={a.data}
                        alt={a.name}
                        className="max-w-[200px] max-h-[150px] rounded object-cover"
                      />
                    ))}
                    {msg.attachments.filter(a => a.type !== 'image').map((a, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-xs bg-white/20 rounded px-2 py-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                        {a.name}
                      </span>
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
              title="Attach files"
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
              placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
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
