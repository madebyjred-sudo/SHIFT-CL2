import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Check, Copy, Terminal, Code2, FileJson, FileCode2, Database, Globe, Cpu, Play } from 'lucide-react';
import { cn } from '@/lib/utils';

// Match plain timecodes: 15:10, 1:57:26 (M:SS or H:MM:SS).
// Negative-number guards on both sides keep us from grabbing pieces of
// longer runs of digits (e.g. phone numbers, IDs).
const TIMECODE_RX = /(?<!\d)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?!\d)/g;

function timecodeToSeconds(h: string | undefined, m: string, s: string): number {
  // Two-part match (M:SS) lands here as h=undefined, m=mins, s=secs.
  // Three-part match (H:MM:SS) keeps all three.
  const hours = h ? parseInt(h, 10) : 0;
  const mins = parseInt(m, 10);
  const secs = parseInt(s, 10);
  return hours * 3600 + mins * 60 + secs;
}

/**
 * Walk markdown children, replacing timecode strings with clickable buttons
 * that call `onSeek(seconds)`. Recursive so it handles nested inline nodes
 * (strong/em/code) without re-implementing each component override.
 *
 * Skip <code> contents — a literal "12:34" inside backticks should stay code.
 */
function linkifyTimecodes(children: React.ReactNode, onSeek: (s: number) => void): React.ReactNode {
  return React.Children.map(children, (child, i) => {
    if (typeof child === 'string') {
      const parts: React.ReactNode[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      TIMECODE_RX.lastIndex = 0;
      while ((match = TIMECODE_RX.exec(child)) !== null) {
        if (match.index > lastIndex) parts.push(child.slice(lastIndex, match.index));
        const [full, h, m, s] = match.length === 4 && match[3] === undefined
          ? [match[0], undefined, match[1], match[2]] as const
          : [match[0], match[1], match[2], match[3]] as const;
        const secs = timecodeToSeconds(h, m as string, s as string);
        parts.push(
          <button
            key={`tc-${i}-${match.index}`}
            type="button"
            onClick={(e) => { e.stopPropagation(); onSeek(secs); }}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-cl2-accent/10 hover:bg-cl2-accent/20 text-cl2-accent font-mono text-[0.85em] tabular-nums transition-colors align-baseline"
            title={`Saltar al ${full} en el reproductor`}
          >
            <Play className="w-2.5 h-2.5 fill-current" />
            {full}
          </button>,
        );
        lastIndex = match.index + full.length;
      }
      if (parts.length === 0) return child;
      if (lastIndex < child.length) parts.push(child.slice(lastIndex));
      return <>{parts}</>;
    }
    if (React.isValidElement(child)) {
      // Don't descend into code blocks — verbatim "12:34" stays as code.
      const type = child.type as any;
      const isCode = type === 'code' || (typeof type === 'string' && type === 'code');
      if (isCode) return child;
      const childProps = child.props as { children?: React.ReactNode };
      if (childProps?.children) {
        return React.cloneElement(child, {
          ...(child.props as object),
          children: linkifyTimecodes(childProps.children, onSeek),
        } as any);
      }
    }
    return child;
  });
}

const getLanguageIcon = (lang: string) => {
  const language = lang.toLowerCase();
  if (['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx'].includes(language)) return <FileCode2 className="w-4 h-4 text-yellow-400" />;
  if (['html', 'xml'].includes(language)) return <Globe className="w-4 h-4 text-orange-500" />;
  if (['css', 'scss', 'less'].includes(language)) return <Code2 className="w-4 h-4 text-blue-400" />;
  if (['json'].includes(language)) return <FileJson className="w-4 h-4 text-green-400" />;
  if (['sql', 'mysql', 'postgresql'].includes(language)) return <Database className="w-4 h-4 text-blue-300" />;
  if (['python', 'py'].includes(language)) return <Cpu className="w-4 h-4 text-yellow-500" />;
  return <Terminal className="w-4 h-4 text-slate-400" />;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className="p-1.5 rounded-md text-white/50 hover:text-white hover:bg-white/10 transition-colors" title="Copy code">
      {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

export function MessageRenderer({
  content,
  isUser,
  onUseAsContext,
  onSeek,
}: {
  content: string;
  isUser?: boolean;
  onUseAsContext?: () => void;
  /** Optional: enables clickable timecodes inside the message body. */
  onSeek?: (seconds: number) => void;
}) {
  // Linkify timecodes whenever onSeek is wired — both for the
  // assistant's citations AND for prefilled user messages that came
  // from "Enviar a Lexa" in the transcript / resumen panes (those
  // include bracketed timecodes the user expects to click back into
  // the player). The `onSeek` prop itself acts as the opt-in: it's
  // only passed when the chat is scoped to a session viewer, so the
  // generic /chat surface stays untouched.
  const wrap = (children: React.ReactNode): React.ReactNode =>
    onSeek ? linkifyTimecodes(children, onSeek) : children;

  return (
    <div className={cn("markdown-body relative group", isUser ? "text-current" : "text-current")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm as any]}
        components={{
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            if (!inline && match) {
              return (
                <div className="relative mt-4 first:mt-0 rounded-xl overflow-hidden bg-[#1e1e1e] border border-white/10 shadow-lg font-sans">
                  <div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-white/10">
                    <div className="flex items-center gap-2 text-xs text-white/70 font-mono uppercase tracking-wider">
                      {getLanguageIcon(language)}
                      <span>{language}</span>
                    </div>
                    <CopyButton text={String(children).replace(/\n$/, '')} />
                  </div>
                  <SyntaxHighlighter
                    {...props}
                    style={vscDarkPlus}
                    language={language}
                    PreTag="div"
                    customStyle={{ margin: 0, padding: '1rem', background: 'transparent', fontSize: '0.875rem' }}
                  >
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return <code className="bg-black/10 dark:bg-white/10 rounded-md px-1.5 py-0.5 font-mono text-[0.9em]" {...props}>{children}</code>;
          },
          p({ children }) { return <p className="mt-4 first:mt-0 leading-relaxed">{wrap(children)}</p>; },
          a({ href, children }) { return <a href={href} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline font-medium">{children}</a>; },
          ul({ children }) { return <ul className="list-disc pl-6 mt-4 first:mt-0 space-y-1.5">{children}</ul>; },
          ol({ children }) { return <ol className="list-decimal pl-6 mt-4 first:mt-0 space-y-1.5">{children}</ol>; },
          li({ children }) { return <li className="leading-relaxed">{wrap(children)}</li>; },
          h1({ children }) { return <h1 className="text-2xl font-bold mt-6 first:mt-0 mb-4 tracking-tight">{wrap(children)}</h1>; },
          h2({ children }) { return <h2 className="text-xl font-bold mt-5 first:mt-0 mb-3 tracking-tight">{wrap(children)}</h2>; },
          h3({ children }) { return <h3 className="text-lg font-bold mt-4 first:mt-0 mb-3 tracking-tight">{wrap(children)}</h3>; },
          blockquote({ children }) { return <blockquote className="border-l-4 border-blue-500/50 pl-4 italic mt-4 first:mt-0 mb-4 text-current/80 bg-blue-500/5 py-2 pr-4 rounded-r-lg">{wrap(children)}</blockquote>; },
          table({ children }) { return <div className="overflow-x-auto mt-4 first:mt-0 rounded-lg border border-current/10"><table className="min-w-full border-collapse text-sm">{children}</table></div>; },
          th({ children }) { return <th className="border-b border-current/10 px-4 py-3 bg-current/5 font-semibold text-left">{children}</th>; },
          td({ children }) { return <td className="border-b border-current/5 px-4 py-3">{wrap(children)}</td>; },
          strong({ children }) { return <strong className="font-semibold">{wrap(children)}</strong>; },
          em({ children }) { return <em className="italic">{wrap(children)}</em>; },
        }}
      >
        {content as string}
      </ReactMarkdown>

      {onUseAsContext && !isUser && (
        <div className="mt-6 pt-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onUseAsContext}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_0_15px_rgba(79,70,229,0.3)] transition-all"
          >
            <Terminal className="w-4 h-4" />
            Usar conclusión para un nuevo chat
          </button>
        </div>
      )}
    </div>
  );
}
