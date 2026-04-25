import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  variant?: 'default' | 'compact' | 'chat';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'default',
}: EmptyStateProps) {
  const variants = {
    default: 'py-16 px-8',
    compact: 'py-8 px-6',
    chat: 'py-12 px-8',
  };

  return (
    <div className={`flex flex-col items-center justify-center text-center ${variants[variant]}`}>
      {/* Icon Container with Grid Background */}
      {icon && (
        <div className="relative mb-6">
          <div
            className="absolute inset-0 rounded-2xl opacity-20"
            style={{
              backgroundImage: 'radial-gradient(circle, #3C3C46 1px, transparent 1px)',
              backgroundSize: '8px 8px',
            }}
          />
          <div className="relative h-16 w-16 rounded-2xl bg-cl2-surface border border-cl2-border flex items-center justify-center text-cl2-accent">
            {icon}
          </div>
        </div>
      )}

      {/* Title — Figtree Bold */}
      <h3 className="font-display text-xl font-bold text-cl2-fg mb-2 tracking-tight">
        {title}
      </h3>

      {/* Description — Libre Caslon Text */}
      {description && (
        <p className="font-body text-base text-cl2-muted max-w-sm mb-6 leading-relaxed">
          {description}
        </p>
      )}

      {/* Action Button — Fira Sans Medium */}
      {action && (
        <button
          onClick={action.onClick}
          className="px-5 py-2.5 rounded-lg bg-cl2-accent text-white font-ui font-medium text-sm tracking-wide hover:bg-cl2-accent-hover transition-all duration-200"
          style={{ boxShadow: '0 0 20px rgb(244 63 94 / 0.3)' }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

// Specialized Empty States
export function EmptyChat() {
  return (
    <EmptyState
      variant="chat"
      icon={
        <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      }
      title="Iniciá una conversación"
      description="Elegí un agente y empezá a consultar sobre actas, proyectos de ley o transcripciones."
    />
  );
}

export function EmptySidebar() {
  return (
    <EmptyState
      variant="compact"
      icon={
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      }
      title="Sin conversaciones"
      description="Tus consultas aparecerán aquí."
    />
  );
}
