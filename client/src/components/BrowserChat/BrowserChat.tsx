import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from '../../services/api';
import { useLanguage } from '../../context/LanguageContext';

interface BrowserChatProps {
  onComplete?: (result: { output: string; reviewCount?: number }) => void;
  onError?: (error: string) => void;
  platform?: string;
  urls?: string[];
  taskId?: string;
  standalone?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user' | 'system';
  content: Array<{ type: string; text?: string }>;
  timestamp?: string;
}

type TaskStatus = 'idle' | 'starting' | 'running' | 'captcha' | 'completed' | 'failed';

export function BrowserChat({
  onComplete,
  onError,
  platform,
  urls,
  taskId: externalTaskId,
  standalone = false,
}: BrowserChatProps) {
  const { t } = useLanguage();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [taskId, setTaskId] = useState<string | null>(externalTaskId || null);
  const [taskStatus, setTaskStatus] = useState<TaskStatus>(externalTaskId ? 'running' : 'idle');
  const [takeControlUrl, setTakeControlUrl] = useState<string | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

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
    console.log('[BrowserChat] connectStream called with taskId:', tid);
    
    if (eventSourceRef.current) {
      console.log('[BrowserChat] Closing existing EventSource');
      eventSourceRef.current.close();
    }

    console.log('[BrowserChat] Creating new EventSource connection');
    const es = api.connectBrowserStream(tid);
    eventSourceRef.current = es;

    es.addEventListener('message', (e) => {
      console.log('[BrowserChat] Received message event:', e.data);
      try {
        const data = JSON.parse(e.data);
        const chatMsg: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: data.role || 'system',
          content: data.content || [{ type: 'text', text: JSON.stringify(data) }],
          timestamp: data.timestamp,
        };
        console.log('[BrowserChat] Adding message to state:', chatMsg);
        setMessages(prev => [...prev, chatMsg]);
      } catch (err) {
        console.error('[BrowserChat] Failed to parse message event:', err);
      }
    });

    es.addEventListener('status', (e) => {
      console.log('[BrowserChat] Received status event:', e.data);
      try {
        const data = JSON.parse(e.data);
        if (data.status === 'completed' || data.status === 'failed') {
          console.log('[BrowserChat] Setting task status to:', data.status);
          setTaskStatus(data.status);
          setTakeControlUrl(null);
        } else if (data.status === 'running' || data.status === 'launching') {
          console.log('[BrowserChat] Setting task status to: running');
          setTaskStatus('running');
          setTakeControlUrl(null);
        }
      } catch (err) {
        console.error('[BrowserChat] Failed to parse status event:', err);
      }
    });

    es.addEventListener('take_control', (e) => {
      try {
        const data = JSON.parse(e.data);
        setTakeControlUrl(data.browserUrl);
        setTaskStatus('captcha');
      } catch (err) {
        console.error('[BrowserChat] Failed to parse take_control event:', err);
      }
    });

    es.addEventListener('complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        setTaskStatus('completed');
        es.close();
        onComplete?.({
          output: data.output || '',
          reviewCount: data.reviewCount,
        });
      } catch (err) {
        console.error('[BrowserChat] Failed to parse complete event:', err);
      }
    });

    es.addEventListener('error', (e) => {
      if (e instanceof MessageEvent) {
        try {
          const data = JSON.parse(e.data);
          setTaskStatus('failed');
          onError?.(data.error || 'Unknown error');
        } catch {
          // Non-JSON error event
        }
      }
    });

    es.onerror = (err) => {
      console.error('[BrowserChat] SSE connection error:', err);
      console.warn('[BrowserChat] SSE connection error, will retry...');
    };

    console.log('[BrowserChat] All event listeners attached');
  }, [onComplete, onError]);

  // Auto-start when platform and urls are provided
  useEffect(() => {
    if (platform && urls && urls.length > 0 && !taskId) {
      startTask(platform, urls);
    }
  }, []); // run only on mount

  // Connect to existing task
  useEffect(() => {
    console.log('[BrowserChat] useEffect for external task, externalTaskId:', externalTaskId, 'hasEventSource:', !!eventSourceRef.current);
    if (externalTaskId && !eventSourceRef.current) {
      console.log('[BrowserChat] Connecting to external task:', externalTaskId);
      connectStream(externalTaskId);
    }
  }, [externalTaskId, connectStream]);

  const startTask = async (plat: string, urlList: string[]) => {
    setTaskStatus('starting');
    setMessages([]);
    setTakeControlUrl(null);
    try {
      const { taskId: newTaskId } = await api.startBrowserTask(plat, urlList);
      setTaskId(newTaskId);
      setTaskStatus('running');
      connectStream(newTaskId);
    } catch (err: any) {
      setTaskStatus('failed');
      onError?.(err.message || 'Failed to start browser task');
    }
  };

  const handleResume = async () => {
    if (!taskId || isResuming) return;
    setIsResuming(true);
    try {
      await api.resumeBrowserTask(taskId);
      setTakeControlUrl(null);
      setTaskStatus('running');
    } catch (err: any) {
      onError?.(err.message || 'Failed to resume task');
    } finally {
      setIsResuming(false);
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
            {t('browserChat.title')}
          </span>
        </div>
        <span className="text-xs text-secondary-500">
          {taskStatus === 'idle' && t('browserChat.ready')}
          {taskStatus === 'starting' && t('browserChat.starting')}
          {taskStatus === 'running' && t('browserChat.running')}
          {taskStatus === 'captcha' && t('browserChat.captchaDetected')}
          {taskStatus === 'completed' && t('browserChat.completed')}
          {taskStatus === 'failed' && t('browserChat.failed')}
        </span>
      </div>

      {/* Message list */}
      <div
        className={`flex-1 overflow-y-auto p-4 space-y-3`}
        style={messageListStyle}
      >
        {messages.length === 0 && taskStatus !== 'idle' && (
          <div className="flex items-center justify-center h-32 text-secondary-400 text-sm">
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-500"></div>
              <span>{t('browserChat.launching')}</span>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* CAPTCHA banner */}
      {takeControlUrl && taskStatus === 'captcha' && (
        <div className="border-t border-secondary-200 p-3 bg-amber-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3 min-w-0">
              <div className="flex-shrink-0 w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-800">{t('browserChat.captchaTitle')}</p>
                <p className="text-xs text-amber-600 mt-0.5">{t('browserChat.captchaDesc')}</p>
              </div>
            </div>
            <div className="flex items-center space-x-2 flex-shrink-0 ml-3">
              <a
                href={takeControlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors inline-flex items-center space-x-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                <span>{t('browserChat.openDebugger')}</span>
              </a>
              <button
                onClick={handleResume}
                disabled={isResuming}
                className="px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {isResuming ? t('browserChat.resuming') : t('browserChat.resume')}
              </button>
            </div>
          </div>
          <p className="text-xs text-amber-500 mt-2 flex items-center space-x-1">
            <svg className="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" /></svg>
            <span>{t('browserChat.captchaHint')}</span>
          </p>
        </div>
      )}

      {/* Completion area */}
      {taskStatus === 'completed' && (
        <div className="border-t border-secondary-200 p-3 bg-green-50">
          <div className="flex items-center space-x-2 text-green-700 text-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{t('browserChat.completed')}</span>
          </div>
        </div>
      )}

      {/* Error state */}
      {taskStatus === 'failed' && (
        <div className="border-t border-secondary-200 p-3 bg-red-50">
          <div className="flex items-center space-x-2 text-red-700 text-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>{t('browserChat.failed')}</span>
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
    running: 'bg-blue-500 animate-pulse',
    captcha: 'bg-amber-500 animate-pulse',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
  };

  return <div className={`w-2 h-2 rounded-full ${colors[status]}`} />;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isSystem = message.role === 'system';

  if (isSystem) {
    const text = message.content
      .filter(c => c.text)
      .map(c => c.text)
      .join(' ');

    return (
      <div className="flex items-start space-x-2">
        <div className="flex-shrink-0 w-5 h-5 bg-blue-100 rounded-full flex items-center justify-center mt-0.5">
          <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="px-3 py-1.5 bg-secondary-100 rounded-lg text-sm text-secondary-700 max-w-[90%]">
          {text}
        </div>
      </div>
    );
  }

  const text = message.content
    .filter(c => c.text)
    .map(c => c.text)
    .join(' ');

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-lg px-4 py-2 bg-secondary-100 text-secondary-900 text-sm">
        {text}
      </div>
    </div>
  );
}

export default BrowserChat;
