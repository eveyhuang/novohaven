import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Button, Card, CardBody } from '../common';
import api from '../../services/api';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load sessions on mount
  useEffect(() => {
    loadSessions();
  }, []);

  // Connect SSE when active session changes
  useEffect(() => {
    if (!activeSessionId) return;

    // Close previous connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = api.connectAgentStream(activeSessionId);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') return;

        if (data.type === 'token' || data.type === 'chunk') {
          // Streaming token - append to the last assistant message or create one
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.id === data.messageId) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + (data.content || data.token || '') },
              ];
            }
            // New assistant message
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
          // Complete message
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === data.id);
            if (existing) {
              return prev.map((m) =>
                m.id === data.id ? { ...m, content: data.content } : m
              );
            }
            return [
              ...prev,
              {
                id: data.id || `msg-${Date.now()}`,
                role: data.role || 'assistant',
                content: data.content,
                timestamp: data.timestamp || new Date().toISOString(),
              },
            ];
          });
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

    return () => {
      es.close();
      eventSourceRef.current = null;
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

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending || streaming) return;

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

    // Add user message to UI immediately
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setSending(true);

    try {
      await api.sendAgentMessage(sessionId, text);
    } catch (err: any) {
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
          <div className="p-3 border-b border-secondary-200">
            <Button
              onClick={startNewSession}
              className="w-full"
            >
              + New Chat
            </Button>
          </div>

          {/* Session List */}
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 && (
              <p className="text-sm text-secondary-400 p-4 text-center">
                No conversations yet
              </p>
            )}
            {sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => selectSession(session.id)}
                className={`w-full text-left px-3 py-2.5 text-sm border-b border-secondary-100 transition-colors truncate ${
                  session.id === activeSessionId
                    ? 'bg-primary-50 text-primary-700 font-medium'
                    : 'text-secondary-700 hover:bg-secondary-100'
                }`}
              >
                <div className="truncate">{session.title || 'Untitled'}</div>
                <div className="text-xs text-secondary-400 mt-0.5">
                  {formatTime(session.created_at)}
                </div>
              </button>
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
          <div className="flex items-end gap-2">
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
              disabled={!inputText.trim() || sending || streaming}
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
