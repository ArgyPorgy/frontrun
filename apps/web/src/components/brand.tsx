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

export function XLogo({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.714 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function TelegramLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <circle cx="12" cy="12" r="12" fill="#29a9eb" />
      <path fill="#fff" d="M5.4 11.8c3.5-1.5 5.8-2.5 7-3 3.3-1.4 4-1.6 4.5-1.6.1 0 .3 0 .5.2.1.1.2.3.2.4v.6c-.2 1.9-1 6.6-1.4 8.7-.2.9-.5 1.2-.8 1.2-.7.1-1.3-.5-1.9-.9-1-.7-1.6-1-2.6-1.7-1.1-.7-.4-1.1.3-1.8.2-.2 3-2.8 3.1-3 0 0 0-.1-.1-.2h-.3c-.1 0-1.8 1.1-5 3.3-.5.3-.9.5-1.3.5-.4 0-1.2-.2-1.8-.4-.7-.2-1.3-.4-1.2-.8 0-.2.3-.4.8-.6z" />
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
