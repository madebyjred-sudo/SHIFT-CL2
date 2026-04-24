import { useEffect, useState } from 'react';
import type { Agent } from '@shift-cl2/shared-types';

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('lexa');
  const [deepInsight, setDeepInsight] = useState(false);
  const [health, setHealth] = useState<string>('checking…');

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => setAgents([]));

    fetch('/health')
      .then((r) => r.json())
      .then((d) => setHealth(d.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'));
  }, []);

  return (
    <div className="min-h-screen bg-cl2-bg text-cl2-fg">
      <header className="border-b border-cl2-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-cl2-accent" aria-label="CL2 logo placeholder" />
          <div>
            <h1 className="text-lg font-semibold">Shift CL2</h1>
            <p className="text-xs text-cl2-muted">Inteligencia Legislativa · Asamblea de Costa Rica</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-cl2-muted">
          <span>api: {health}</span>
          <span>tenant: cl2</span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <section>
          <h2 className="text-sm uppercase tracking-wide text-cl2-muted mb-3">Agentes</h2>
          <div className="grid grid-cols-3 gap-3">
            {agents.length === 0 && (
              <div className="col-span-3 rounded border border-dashed border-cl2-border p-6 text-cl2-muted text-sm">
                No hay agentes cargados todavía. Verifica que `apps/api` esté corriendo.
              </div>
            )}
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => setActiveAgent(a.id)}
                className={`text-left rounded-lg border p-4 transition ${
                  activeAgent === a.id
                    ? 'border-cl2-accent bg-cl2-surface ring-1 ring-cl2-accent'
                    : 'border-cl2-border bg-cl2-surface hover:border-cl2-accent/50'
                }`}
              >
                <div className="font-semibold">{a.display_name}</div>
                <div className="text-xs text-cl2-muted mt-1">{a.tagline}</div>
                <div className="text-[10px] text-cl2-muted mt-2 uppercase tracking-wide">{a.domain}</div>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm uppercase tracking-wide text-cl2-muted">Conversación</h2>
            <label className="flex items-center gap-2 text-xs text-cl2-muted cursor-pointer">
              <input
                type="checkbox"
                checked={deepInsight}
                onChange={(e) => setDeepInsight(e.target.checked)}
                className="accent-cl2-accent"
              />
              Deep Insight
            </label>
          </div>
          <div className="rounded-lg border border-cl2-border bg-cl2-surface p-6 min-h-[300px] text-cl2-muted text-sm">
            Chat stub. Agente activo: <strong className="text-cl2-fg">{activeAgent}</strong>
            {deepInsight && <span className="ml-2 text-cl2-accent">· Deep Insight ON</span>}
            <p className="mt-4 text-xs">Sprint 2 conecta SSE → Cerebro. Por ahora UI stub.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
