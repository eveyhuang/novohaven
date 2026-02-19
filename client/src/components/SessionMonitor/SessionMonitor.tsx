import React, { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Button, Card, CardBody } from '../common';
import api from '../../services/api';

interface Session {
  id: string;
  channel_type: string;
  status: string;
  last_active_at: string;
  user_email: string;
  message_count: number;
}

interface Message {
  role: string;
  content: string;
  timestamp: string;
}

interface SessionDetail {
  messages: Message[];
}

const REFRESH_INTERVAL = 30_000;

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...` : id;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    idle: 'bg-yellow-100 text-yellow-800',
    closed: 'bg-secondary-100 text-secondary-600',
  };
  const cls = colors[status] || 'bg-secondary-100 text-secondary-600';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

function ChannelBadge({ channel }: { channel: string }) {
  const colors: Record<string, string> = {
    web: 'bg-blue-100 text-blue-800',
    lark: 'bg-purple-100 text-purple-800',
  };
  const cls = colors[channel] || 'bg-secondary-100 text-secondary-600';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {channel}
    </span>
  );
}

function SessionDetailPanel({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getSession(sessionId)
      .then((data: SessionDetail) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (loading) {
    return <div className="p-4 text-secondary-500 text-sm">Loading transcript...</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500 text-sm">Error: {error}</div>;
  }

  if (!detail || detail.messages.length === 0) {
    return <div className="p-4 text-secondary-400 text-sm">No messages in this session.</div>;
  }

  return (
    <div className="p-4 space-y-3 max-h-96 overflow-y-auto bg-secondary-50 border-t border-secondary-200">
      {detail.messages.map((msg, idx) => (
        <div
          key={idx}
          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
              msg.role === 'user'
                ? 'bg-primary-600 text-white'
                : 'bg-white border border-secondary-200 text-secondary-800'
            }`}
          >
            <div className="font-medium text-xs opacity-70 mb-1">
              {msg.role} - {formatTime(msg.timestamp)}
            </div>
            <div className="whitespace-pre-wrap">{msg.content}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SessionMonitor() {
  const { t } = useLanguage();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [closingAll, setClosingAll] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await api.getSessions();
      setSessions(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const handleClose = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (closingIds.has(sessionId)) return;

    setClosingIds((prev) => new Set(prev).add(sessionId));
    try {
      await api.closeSession(sessionId);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status: 'closed' } : s))
      );
      if (expandedId === sessionId) setExpandedId(null);
    } catch (err: any) {
      console.error('Failed to close session:', err);
    } finally {
      setClosingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleCloseAll = async () => {
    if (closingAll) return;
    setClosingAll(true);
    try {
      await api.closeAllSessions();
      setSessions((prev) =>
        prev.map((s) => (s.status !== 'closed' ? { ...s, status: 'closed' } : s))
      );
      setExpandedId(null);
    } catch (err: any) {
      console.error('Failed to close all sessions:', err);
    } finally {
      setClosingAll(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-secondary-500">Loading sessions...</div>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardBody>
          <div className="text-red-500 text-center py-8">
            <p className="mb-4">Error: {error}</p>
            <Button variant="secondary" onClick={fetchSessions}>
              Retry
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-secondary-800">Session Monitor</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="danger"
            size="sm"
            isLoading={closingAll}
            disabled={closingAll || sessions.every((s) => s.status === 'closed')}
            onClick={handleCloseAll}
          >
            Close All
          </Button>
          <Button variant="secondary" size="sm" onClick={fetchSessions}>
            Refresh
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-secondary-400 text-center py-8">No active sessions.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-secondary-200 bg-secondary-50 text-left text-secondary-600">
                  <th className="px-4 py-3 font-medium">Session ID</th>
                  <th className="px-4 py-3 font-medium">Channel</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Last Active</th>
                  <th className="px-4 py-3 font-medium">Messages</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <React.Fragment key={session.id}>
                    <tr
                      className={`border-b border-secondary-100 hover:bg-secondary-50 cursor-pointer transition-colors ${
                        expandedId === session.id ? 'bg-secondary-50' : ''
                      }`}
                      onClick={() => toggleExpand(session.id)}
                    >
                      <td className="px-4 py-3 font-mono text-xs" title={session.id}>
                        {truncateId(session.id)}
                      </td>
                      <td className="px-4 py-3">
                        <ChannelBadge channel={session.channel_type} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={session.status} />
                      </td>
                      <td className="px-4 py-3 text-secondary-600">
                        {session.user_email || '-'}
                      </td>
                      <td className="px-4 py-3 text-secondary-500 text-xs">
                        {formatTime(session.last_active_at)}
                      </td>
                      <td className="px-4 py-3 text-secondary-700">
                        {session.message_count}
                      </td>
                      <td className="px-4 py-3">
                        {session.status !== 'closed' && (
                          <Button
                            variant="danger"
                            size="sm"
                            isLoading={closingIds.has(session.id)}
                            onClick={(e) => handleClose(e, session.id)}
                          >
                            Close
                          </Button>
                        )}
                      </td>
                    </tr>
                    {expandedId === session.id && (
                      <tr>
                        <td colSpan={7}>
                          <SessionDetailPanel sessionId={session.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-secondary-400 text-right">
        Auto-refreshes every 30 seconds
      </p>
    </div>
  );
}
