import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ExecutionChatMessage } from '../../../types';

interface OutputMessageProps {
  message: ExecutionChatMessage;
}

const OutputMessage: React.FC<OutputMessageProps> = ({ message }) => {
  const [copied, setCopied] = useState(false);
  const isJson = message.metadata?.isJson;
  const images = message.metadata?.images;
  const files = message.metadata?.files;

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] w-full bg-white border border-secondary-200 rounded-lg shadow-sm overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-secondary-50 border-b border-secondary-200">
          <span className="text-xs font-medium text-secondary-500">
            Output{message.metadata?.model ? ` (${message.metadata.model})` : ''}
          </span>
          <button
            onClick={handleCopy}
            className="text-xs text-secondary-400 hover:text-secondary-600 transition-colors"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {isJson ? (
            <pre className="text-xs font-mono bg-secondary-50 p-3 rounded overflow-x-auto max-h-96 whitespace-pre-wrap">
              {message.content}
            </pre>
          ) : (
            <div className="prose prose-sm max-w-none text-secondary-800">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          )}

          {/* Images */}
          {images && images.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType};base64,${img.base64}`}
                  alt={`Generated ${i + 1}`}
                  className="rounded-lg border border-secondary-200 w-full"
                />
              ))}
            </div>
          )}

          {/* Files */}
          {files && files.length > 0 && (
            <div className="mt-3 space-y-1">
              {files.map((file, i) => (
                <a
                  key={i}
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-primary-600 hover:text-primary-700"
                >
                  <span>&#128196;</span>
                  <span>{file.name}</span>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Usage */}
        {message.metadata?.usage && (
          <div className="px-3 py-1.5 bg-secondary-50 border-t border-secondary-200 text-xs text-secondary-400">
            Tokens: {message.metadata.usage.promptTokens} in / {message.metadata.usage.completionTokens} out
          </div>
        )}
      </div>
    </div>
  );
};

export default OutputMessage;
