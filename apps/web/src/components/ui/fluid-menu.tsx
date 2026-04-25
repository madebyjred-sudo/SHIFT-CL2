import React, { useState } from 'react';

interface MenuItemProps {
  onClick?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  isActive?: boolean;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export function MenuItem({
  onClick,
  disabled = false,
  icon,
  isActive = false,
  ariaLabel,
  children,
}: MenuItemProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`relative w-full h-full text-center group rounded-full transition-colors flex items-center justify-center
        ${
          disabled
            ? 'text-gray-400 dark:text-white/30 cursor-not-allowed'
            : 'text-gray-600 dark:text-white/70 hover:text-[#0e1745] dark:hover:text-white'
        }
        ${isActive ? 'text-cl2-accent dark:text-cl2-accent-soft' : ''}
      `}
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
    >
      {icon && (
        <span className="h-5 w-5 transition-all duration-200 group-hover:[&_svg]:stroke-[2.25]">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}

interface MenuContainerProps {
  trigger: (state: { isExpanded: boolean; toggle: () => void }) => React.ReactNode;
  children: React.ReactNode;
  size?: number;
  spacing?: number;
}

/**
 * Fluid vertical-stack menu. Trigger always visible (render-prop receives
 * expanded state). Items fan out below on toggle. Compact for top-dock.
 */
export function MenuContainer({
  trigger,
  children,
  size = 36,
  spacing = 42,
}: MenuContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const toggle = () => setIsExpanded((v) => !v);
  const childrenArray = React.Children.toArray(children);

  return (
    <div className="relative" style={{ width: size }} data-expanded={isExpanded}>
      <div className="relative" style={{ height: size }}>
        {/* Trigger */}
        <div
          className="relative bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 cursor-pointer rounded-full group will-change-transform z-50 transition-colors flex items-center justify-center text-[#0e1745]/60 dark:text-white/60"
          style={{ width: size, height: size }}
          onClick={toggle}
        >
          {trigger({ isExpanded, toggle })}
        </div>

        {/* Fan-out items */}
        {childrenArray.map((child, index) => (
          <div
            key={index}
            className="absolute top-0 left-0 bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 will-change-transform rounded-full transition-colors"
            style={{
              width: size,
              height: size,
              transform: `translateY(${isExpanded ? (index + 1) * spacing : 0}px)`,
              opacity: isExpanded ? 1 : 0,
              pointerEvents: isExpanded ? 'auto' : 'none',
              // Items must sit above the backdrop (z-40) or clicks fall through
              // to the close-on-outside handler instead of firing onNavigate.
              zIndex: 60 - index,
              transition: `transform 300ms cubic-bezier(0.4, 0, 0.2, 1),
                           opacity ${isExpanded ? '300ms' : '200ms'}`,
              backfaceVisibility: 'hidden',
              WebkitFontSmoothing: 'antialiased',
            }}
          >
            {child}
          </div>
        ))}
      </div>

      {isExpanded && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setIsExpanded(false)}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
