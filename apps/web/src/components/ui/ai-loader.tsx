import * as React from "react";

interface LoaderProps {
  size?: number;
  text?: string;
}

export const Component: React.FC<LoaderProps> = ({ size = 40, text = "" }) => {
  const letters = text.split("");
  return (
    <div className="relative flex items-center justify-center select-none" style={{ width: size, height: size }}>
      {letters.map((letter, index) => (
        <span
          key={index}
          className="inline-block text-white/60 opacity-40"
          style={{
            animation: `loaderLetter 3s infinite`,
            animationDelay: `${index * 0.1}s`
          }}
        >
          {letter}
        </span>
      ))}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          animation: 'loaderCircle 5s linear infinite',
          boxShadow: '0 6px 12px 0 #38bdf8 inset, 0 12px 18px 0 #005dff inset, 0 36px 36px 0 #1e40af inset, 0 0 3px 1.2px rgba(56, 189, 248, 0.3), 0 0 6px 1.8px rgba(0, 93, 255, 0.2)'
        }}
      />
      <style>{`
        @keyframes loaderCircle {
          0% { transform: rotate(90deg); }
          50% { transform: rotate(270deg); }
          100% { transform: rotate(450deg); }
        }
        @keyframes loaderLetter {
          0%, 100% { opacity: 0.4; transform: translateY(0); }
          20% { opacity: 1; transform: scale(1.15); }
          40% { opacity: 0.7; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};
