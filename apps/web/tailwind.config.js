/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cl2: {
          bg: 'rgb(var(--cl2-bg) / <alpha-value>)',
          surface: 'rgb(var(--cl2-surface) / <alpha-value>)',
          border: 'rgb(var(--cl2-border) / <alpha-value>)',
          fg: 'rgb(var(--cl2-fg) / <alpha-value>)',
          muted: 'rgb(var(--cl2-muted) / <alpha-value>)',
          accent: 'rgb(var(--cl2-accent) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
