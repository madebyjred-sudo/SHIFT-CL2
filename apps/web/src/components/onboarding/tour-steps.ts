/**
 * Tour steps for the CL2 onboarding.
 *
 * Each step targets a DOM element via [data-tour="..."]. Some steps are
 * "intro" / "outro" steps that don't target an element (no `element` field)
 * — driver.js renders those centered with a fully blurred background.
 *
 * Conventions:
 * - All copy in Spanish (Costa Rica voice).
 * - Newsreader for titles (`.cl2-tour-title`), Figtree for body.
 * - `data-tour` selectors are added to landmark elements in the React tree.
 *   Search for `data-tour=` in the codebase to find them.
 */

export type TourStep = {
  /** CSS selector for the element to spotlight. Omit for centered modal-style step. */
  element?: string;
  popover: {
    title: string;
    description: string;
    /** Optional side hint for driver.js placement. */
    side?: 'top' | 'bottom' | 'left' | 'right' | 'over';
    align?: 'start' | 'center' | 'end';
  };
  /** Optional: route this step requires the user to be on. Tour will navigate before showing. */
  requireRoute?: string;
};

/**
 * Main onboarding tour — runs on first login. ~60s total.
 *
 * Story arc: welcome → orient → first action → value reveal → handoff.
 */
export const MAIN_TOUR_STEPS: TourStep[] = [
  // 0 — Welcome (no target, centered)
  {
    popover: {
      title: 'Bienvenido a CL2',
      description: `
        <p class="cl2-tour-lede">
          En 60 segundos vas a tener todo lo que necesitás para investigar
          legislación con IA <em>verificable</em>.
        </p>
        <p class="cl2-tour-meta">Te recomendamos hacerlo ahora — es muy rápido.</p>
      `,
    },
  },

  // 1 — Brand / context anchor
  {
    element: '[data-tour="brand"]',
    popover: {
      title: 'Tu hub legislativo',
      description: `
        <p>Acá vivís tu trabajo legislativo: chat con <strong>Lexa</strong>,
        catálogo del SIL, sesiones de la Asamblea, y tus hojas de trabajo.</p>
      `,
      side: 'bottom',
      align: 'start',
    },
  },

  // 2 — Lexa input (the main action)
  {
    element: '[data-tour="lexa-input"]',
    popover: {
      title: 'Hablale a Lexa',
      description: `
        <p>Mandale cualquier consulta. Probá con:</p>
        <p class="cl2-tour-prompt">"¿Qué proyectos hay sobre fintech en comisión?"</p>
        <p class="cl2-tour-meta">Lexa busca en SIL, expedientes, sesiones y reglamento — y siempre cita la fuente.</p>
      `,
      side: 'top',
      align: 'center',
    },
  },

  // 3 — History toggle (where conversations live)
  {
    element: '[data-tour="history-toggle"]',
    popover: {
      title: 'Tu historial, siempre',
      description: `
        <p>Cada conversación queda guardada. Volvés a cualquier consulta vieja
        con un click — todo persistido en tu cuenta.</p>
      `,
      side: 'bottom',
      align: 'end',
    },
  },

  // 4 — User nav menu (the rest of the surfaces)
  {
    element: '[data-tour="user-nav"]',
    popover: {
      title: 'Tus secciones',
      description: `
        <ul class="cl2-tour-list">
          <li><strong>Catálogo SIL</strong> — buscar y filtrar expedientes</li>
          <li><strong>Sesiones</strong> — actividad de la Asamblea</li>
          <li><strong>Hojas</strong> — tu workstation editable</li>
          <li><strong>Audios</strong> — historial de podcasts generados</li>
        </ul>
      `,
      side: 'bottom',
      align: 'end',
    },
  },

  // 5 — Theme toggle (small detail, but signals "we care")
  {
    element: '[data-tour="theme-toggle"]',
    popover: {
      title: 'Modo día o noche',
      description: `
        <p>Elegí el que mejor te acompañe. La preferencia se guarda y se mantiene
        consistente en toda la app.</p>
      `,
      side: 'bottom',
      align: 'end',
    },
  },

  // 6 — Help replay button (so they know they can replay this)
  {
    element: '[data-tour="help-replay"]',
    popover: {
      title: 'Si te perdés, este botón',
      description: `
        <p>Tocás el <strong>?</strong> y reproducís este tour cuando quieras.
        También está en cada página clave por si te abruma algo nuevo.</p>
      `,
      side: 'bottom',
      align: 'end',
    },
  },

  // 7 — Closing (no target, centered, celebratory)
  {
    popover: {
      title: 'Listo. Ya estás cooking.',
      description: `
        <p class="cl2-tour-lede">Hacé tu primera consulta a Lexa.</p>
        <p class="cl2-tour-meta">
          Si encontrás algo confuso, tocá el <strong>?</strong> y volvé a este tour.
          Buena investigación.
        </p>
      `,
    },
  },
];

/**
 * Storage key for marking a tour as completed. Versioned so we can bump
 * it when the tour content changes meaningfully — that triggers a re-play
 * for existing users (with a soft entry, not the full thing).
 */
export const TOUR_VERSION = 'v1';
export const TOUR_STORAGE_KEY = `cl2:onboarding:${TOUR_VERSION}:completed`;
export const TOUR_DISMISSED_KEY = `cl2:onboarding:${TOUR_VERSION}:dismissedAt`;
