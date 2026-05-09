/**
 * Cl2Mark — el isotipo de CL2 (asterisco blanco sobre fondo rojo gradient).
 *
 * Versión "mark" (cuadrada, solo el símbolo) usada como avatar pequeño en
 * la TopDock. La versión completa del logo (mark + wordmark "CL2") vive
 * en /src/assets/brand/cl2-logo.svg pero la TopDock usa solo el mark
 * porque al lado del wordmark Newsreader queda demasiado ruido visual.
 *
 * Ambos SVGs son del archivo de marca de CL2 Consultoría
 * (Q1/CL2 LOGO.svg y Q1/cl2 favicon.svg).
 */
import type { CSSProperties } from 'react';

type Props = {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Aplica filter:drop-shadow sutil. Default: true */
  shadow?: boolean;
};

export function Cl2Mark({ size = 36, className, style, shadow = true }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 83.42 83.42"
      width={size}
      height={size}
      className={className}
      style={style}
      role="img"
      aria-label="CL2"
    >
      <defs>
        <linearGradient
          id="cl2-mark-grad"
          x1="40.96"
          y1="36.17"
          x2="60.02"
          y2="177.11"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#f93549" />
          <stop offset=".63" stopColor="#ff6f6d" />
        </linearGradient>
        {shadow && (
          <filter id="cl2-mark-shadow" x="13.46" y="10.56" width="60" height="66" filterUnits="userSpaceOnUse">
            <feOffset dx="1.42" dy="1.42" />
            <feGaussianBlur result="blur" stdDeviation="1.42" />
            <feFlood floodColor="#000" floodOpacity=".15" />
            <feComposite in2="blur" operator="in" />
            <feComposite in="SourceGraphic" />
          </filter>
        )}
      </defs>
      <rect width="83.42" height="83.42" rx="21.21" ry="21.21" fill="url(#cl2-mark-grad)" />
      <g filter={shadow ? 'url(#cl2-mark-shadow)' : undefined} fill="#fff">
        <path d="M34.97,34.64c-5.6-3.09-11.6-6.29-16.4-8.6l-2,3.47c4.41,3.01,10.18,6.6,15.65,9.9l2.75-4.77Z" />
        <path d="M51.45,44.16l-2.75,4.76c5.53,3.05,11.42,6.19,16.15,8.47l2-3.47c-4.34-2.96-10-6.49-15.41-9.76Z" />
        <path d="M38.88,51.37c.12,6.3.36,12.99.76,18.22h4.15c.39-5.23.63-11.92.76-18.22h-5.66Z" />
        <path d="M44.55,32.34c-.12-6.39-.36-13.19-.76-18.51h-4.15c-.4,5.31-.64,12.12-.76,18.51h5.67Z" />
        <path d="M64.85,26.03c-7.3,3.52-17.45,9.09-24.57,13.2-7.12,4.11-17.02,10.11-23.72,14.68l2,3.47c7.3-3.52,17.45-9.09,24.57-13.2,7.12-4.11,17.02-10.11,23.72-14.68l-2-3.47Z" />
      </g>
    </svg>
  );
}
