/**
 * /landing — public marketing surface.
 *
 * Public route: renders BEFORE the auth gate in App.tsx so prospects can
 * visit without logging in. Eventually the apex `agentescl2.com` will
 * 302 / serve this content; for now we live under /landing alongside
 * the SPA.
 *
 * Faithful port of the cl2-landing draft — same component tree, same
 * CSS utilities (.shell, .display, .lede, .btn-coral, .italic-serif,
 * etc, all defined in styles/landing.css). The only behavioral change
 * is in HeroDashboard: the mock chat is replaced by a real conversation
 * against /api/public/demo-chat, capped at 5 prompts per IP per 24h
 * with extra server-side safeguards.
 *
 * Copy follows docs/LANDING-CONTEXT.md. Hard rules:
 *   - Spanish from Costa Rica (vos, acá, plenario, fracción, dictamen)
 *   - Editorial NOT corporate. Newsreader display + Figtree body.
 *   - NO AI hype. NO "RAG/embeddings/vector". NO "powered by GPT/Claude".
 *   - Concrete verifiable numbers only. If unsure, "decenas de miles".
 *   - "el operador escribe lineamientos editoriales" — the curaduría
 *     flywheel narrative is internal-only.
 *   - CTA = "Solicitar acceso al piloto" / "Agendá una demo de 30 min",
 *     NOT "regístrate gratis".
 */
import { ViewportFrame } from '@/components/landing/cl2/ViewportFrame';
import { Hero } from '@/components/landing/cl2/Hero';
import { Problem } from '@/components/landing/cl2/Problem';
import { MemoriaViva } from '@/components/landing/cl2/MemoriaViva';
import { Almas } from '@/components/landing/cl2/Almas';
import { Capabilities } from '@/components/landing/cl2/Capabilities';
import { Comparison } from '@/components/landing/cl2/Comparison';
import { LiveProof } from '@/components/landing/cl2/LiveProof';
import { CtaCloser } from '@/components/landing/cl2/CtaCloser';
import { FAQ } from '@/components/landing/cl2/FAQ';
import { Manifesto } from '@/components/landing/cl2/Manifesto';
import { Footer } from '@/components/landing/cl2/Footer';
import '@/styles/landing.css';

export function LandingPage() {
  return (
    <div className="relative min-h-screen bg-cl2-paper text-cl2-ink overflow-x-hidden">
      <div className="bg-pixel-dots opacity-60 fixed inset-0 z-0 pointer-events-none" aria-hidden />
      <ViewportFrame />
      <div className="relative z-10">
        <main>
          {/* Flujo psicológico:
              Hero          → status positioning ("el mejor preparado")
              Problem       → loss aversion ("lo que perdés sin esto")
              MemoriaViva   → authority sin alarde técnico (cerebro creciente)
              Almas         → personification (3 oficios, no features)
              Capabilities  → escenarios concretos (availability heuristic)
              Comparison    → contrast effect (vs IA general / archivo nativo / método tradicional)
              LiveProof     → reciprocity + IKEA effect (probalo antes de pedir)
              CtaCloser     → scarcity ("10 fracciones en 2026")
              FAQ           → regret aversion (resolver dudas residuales)
              Manifesto     → unity principle + Lindy effect (cierre filosófico) */}
          <Hero />
          <Problem />
          <MemoriaViva />
          <Almas />
          <Capabilities />
          <Comparison />
          <LiveProof />
          <CtaCloser />
          <FAQ />
          <Manifesto />
        </main>
        <Footer />
      </div>
    </div>
  );
}
