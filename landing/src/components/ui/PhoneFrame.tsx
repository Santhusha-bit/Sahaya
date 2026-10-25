import type { ReactNode } from "react";

/** Reusable device frame for product mockups. */
export function PhoneFrame({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`phone ${className}`}>
      {/* Notch */}
      <div className="absolute left-1/2 top-[18px] z-20 h-[22px] w-[94px] -translate-x-1/2 rounded-full bg-[#0d1b24]" />
      <div className="phone-screen">{children}</div>
    </div>
  );
}
