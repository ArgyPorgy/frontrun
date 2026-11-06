import { useId } from "react";

/** The logo: a white play arrow, then the gradient arrow and bar it's running ahead to. */
export function LogoMark({ width = 24, className = "" }: { width?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={width} height={width * (416 / 580)} viewBox="0 0 580 416" aria-hidden className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00f5a0" />
          <stop offset="1" stopColor="#00d0ea" />
        </linearGradient>
      </defs>
      <path fill="#f5f4f7" d="M0 0 237 208 0 416Z" />
      <path fill={`url(#${id})`} d="M234 0 495 208 234 416Z" />
      <rect fill={`url(#${id})`} x="522" width="58" height="416" rx="10" />
    </svg>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <LogoMark width={size} />
      <span className="font-display text-lg font-semibold tracking-tight">frontrun</span>
    </span>
  );
}
