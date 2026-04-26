/**
 * Hero editorial de /sesiones — solo título Newsreader con énfasis burgundy.
 *
 * Versión simplificada (2026-04-26): se removieron eyebrow, lede, KPIs y
 * densidad heatmap para dejar el título como única pieza editorial. La
 * información cuantitativa vive ahora en el toolbar y los filtros.
 *
 * Padding horizontal alineado al TopDock (`px-4 sm:px-5 md:px-6`) para
 * que la columna de contenido sea consistente de arriba a abajo.
 */
import { motion } from 'motion/react';

export function SesionesHero() {
  return (
    <header className="px-4 sm:px-5 md:px-6 pt-8 pb-7">
      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="font-display font-light text-[34px] sm:text-[40px] leading-[1.05] tracking-[-0.015em] text-[#0e1745] dark:text-white"
      >
        Toda la actividad de la Asamblea —{' '}<em className="not-italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft italic">citable, fechada, buscable</em>.
      </motion.h1>
    </header>
  );
}
