type LogoProps = {
  size?: number;
  withWordmark?: boolean;
  className?: string;
};

/**
 * Sahaya brand mark: a protective embrace of three linked care nodes,
 * representing connection, protection, and care in one symbol.
 */
export function Logo({ size = 36, withWordmark = true, className = "" }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 512 512"
        aria-hidden="true"
        className="shrink-0"
      >
        <defs>
          <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#19A396" />
            <stop offset="0.55" stopColor="#168B82" />
            <stop offset="1" stopColor="#4779B8" />
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="120" fill="url(#logo-g)" />
        <path
          d="M256 92c44 30 98 44 142 44 0 120-40 214-142 248-102-34-142-128-142-248 44 0 98-14 142-44Z"
          fill="#ffffff"
          fillOpacity="0.14"
        />
        <path
          d="M186 232c0-39 31-70 70-70s70 31 70 70c0 48-70 96-70 96"
          stroke="#ffffff"
          strokeWidth="22"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="186" cy="326" r="26" fill="#ffffff" />
        <circle cx="326" cy="326" r="26" fill="#ffffff" />
        <circle cx="256" cy="356" r="30" fill="#ffffff" />
        <path
          d="M186 326c40 44 100 44 140 0"
          stroke="#ffffff"
          strokeWidth="22"
          strokeLinecap="round"
          fill="none"
          opacity="0.65"
        />
      </svg>
      {withWordmark && (
        <span
          className="font-extrabold tracking-tight text-ink"
          style={{ fontSize: size * 0.62 }}
        >
          Sahaya
        </span>
      )}
    </span>
  );
}
