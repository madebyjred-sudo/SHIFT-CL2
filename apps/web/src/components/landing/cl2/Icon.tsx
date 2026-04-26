import { cn } from "@/lib/utils";

type IconName =
  | "arrow-right" | "arrow-up-right" | "arrow-down" | "arrow-left"
  | "check" | "x" | "minus" | "plus"
  | "lock" | "shield" | "archive" | "quote" | "send" | "sparkles" | "eye"
  | "book" | "compass" | "menu" | "circle" | "play" | "moon" | "sun" | "scale" | "radar";

export const Icon = ({
  name,
  size = 16,
  stroke = 1.5,
  className,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
}) => {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: cn("inline-block flex-shrink-0", className),
  };
  switch (name) {
    case "arrow-right": return <svg {...props}><path d="M5 12h14M13 5l7 7-7 7" /></svg>;
    case "arrow-left": return <svg {...props}><path d="M19 12H5M11 5l-7 7 7 7" /></svg>;
    case "arrow-up-right": return <svg {...props}><path d="M7 17 17 7M7 7h10v10" /></svg>;
    case "arrow-down": return <svg {...props}><path d="M12 5v14M19 12l-7 7-7-7" /></svg>;
    case "check": return <svg {...props}><path d="M20 6 9 17l-5-5" /></svg>;
    case "x": return <svg {...props}><path d="M18 6 6 18M6 6l12 12" /></svg>;
    case "minus": return <svg {...props}><path d="M5 12h14" /></svg>;
    case "plus": return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case "lock": return <svg {...props}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;
    case "shield": return <svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></svg>;
    case "archive": return <svg {...props}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>;
    case "quote": return <svg {...props}><path d="M3 21c3-2 5-5 5-9V5H4v6h4M21 21c-3-2-5-5-5-9V5h-4v6h4" /></svg>;
    case "send": return <svg {...props}><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></svg>;
    case "sparkles": return <svg {...props}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></svg>;
    case "eye": return <svg {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
    case "book": return <svg {...props}><path d="M4 4v16a2 2 0 0 0 2 2h14V4H6a2 2 0 0 0-2 2Z" /><path d="M8 4v18M16 9h-4" /></svg>;
    case "compass": return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="m16 8-4 8-4-4 8-4Z" /></svg>;
    case "menu": return <svg {...props}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
    case "circle": return <svg {...props}><circle cx="12" cy="12" r="9" /></svg>;
    case "play": return <svg {...props}><path d="m6 4 14 8-14 8V4Z" fill="currentColor" /></svg>;
    case "moon": return <svg {...props}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" /></svg>;
    case "sun": return <svg {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>;
    case "scale": return <svg {...props}><path d="M16 16.01V16M8 16.01V16M12 3v18M3 7h18M5 7l3 9h0l3-9M13 7l3 9h0l3-9" /></svg>;
    case "radar": return <svg {...props}><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34M4 6a10 10 0 1 0 14 14" /><circle cx="12" cy="12" r="3" /></svg>;
    default: return <svg {...props}><circle cx="12" cy="12" r="9" /></svg>;
  }
};
