import React from 'react';

interface Citation {
  id: string;
  text: string;
  source: string;
  url?: string;
}

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  agentName?: string;
  agentColor?: string;
  timestamp?: string;
  citations?: Citation[];
}

export function MessageBubble({
  role,
  content,
  agentName,
  agentColor = '#F43F5E',
  timestamp,
  citations,
}: MessageBubbleProps) {
  const isUser = role === 'user';
  const isSystem = role === 'system';

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      {!isSystem && (
        <div
          className="flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold text-white font-display"
          style={{ backgroundColor: isUser ? '#3B82F6' : agentColor }}
        >
          {isUser ? 'U' : agentName?.[0] || 'A'}
        </div>
      )}

      {/* Message Content */}
      <div className={`flex-1 max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Header */}
        <div className={`flex items-center gap-2 mb-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
          {!isSystem && (
            <span className="font-subtitle font-medium text-xs text-cl2-muted tracking-wide">
              {isUser ? 'Vos' : agentName}
            </span>
          )}
          {timestamp && (
            <span className="font-mono text-[10px] text-cl2-muted-dark">{timestamp}</span>
          )}
        </div>

        {/* Bubble */}
        <div
          className={`
            rounded-2xl px-4 py-3 text-sm leading-relaxed
            ${isUser
              ? 'bg-cl2-lexa text-white rounded-tr-sm font-body'
              : isSystem
                ? 'bg-transparent text-cl2-muted text-center italic font-body'
                : 'bg-cl2-surface text-cl2-fg border border-cl2-border rounded-tl-sm font-body'
            }
          `}
        >
          {content}
        </div>

        {/* Citations — Fira Code for legal refs */}
        {citations && citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {citations.map((cite) => (
              <a
                key={cite.id}
                href={cite.url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-cl2-surface-hover border border-cl2-border font-mono text-xs text-cl2-muted hover:text-cl2-accent hover:border-cl2-accent transition-colors"
              >
                <span className="text-cl2-accent">#{cite.id}</span>
                <span className="truncate max-w-[150px] font-subtitle">{cite.source}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
