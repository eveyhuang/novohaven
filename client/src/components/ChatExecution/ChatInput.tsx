import React, { useState } from 'react';
import api from '../../services/api';

interface ChatInputProps {
  /** Active Manus task ID when a Manus step is running/awaiting input */
  activeManusTaskId?: string | null;
  /** Whether the input should be enabled */
  enabled: boolean;
  /** Called after sending a message so parent can add it to the message list */
  onMessageSent?: (text: string) => void;
}

const ChatInput: React.FC<ChatInputProps> = ({
  activeManusTaskId,
  enabled,
  onMessageSent,
}) => {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !enabled || sending) return;

    setSending(true);
    try {
      if (activeManusTaskId) {
        await api.sendManusMessage(activeManusTaskId, text);
        onMessageSent?.(text);
      }
      setInput('');
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!enabled) return null;

  return (
    <div className="border-t border-secondary-200 px-4 py-3 bg-white">
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            activeManusTaskId
              ? 'Reply to Manus agent...'
              : 'Waiting for active step...'
          }
          disabled={!activeManusTaskId || sending}
          rows={1}
          className="flex-1 resize-none px-3 py-2 border border-secondary-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:bg-secondary-50 disabled:text-secondary-400"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || !activeManusTaskId || sending}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
};

export default ChatInput;
