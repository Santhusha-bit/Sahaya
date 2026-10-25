"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { PhoneFrame } from "./PhoneFrame";

export type ChatMessage = {
  from: "user" | "ai";
  text: string;
};

/** A phone showing an illustrative conversation with a capability header. */
export function ChatPhone({
  title,
  icon: Icon,
  color,
  messages,
  children,
  className = "",
}: {
  title: string;
  icon: LucideIcon;
  color: string;
  messages: ChatMessage[];
  /** Optional status card rendered below the conversation. */
  children?: React.ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();

  return (
    <PhoneFrame className={className}>
      <div className="flex flex-col px-4 pb-5 pt-12">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-line pb-3">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{ background: `${color}1a`, color }}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-bold text-ink">{title}</p>
            <p className="text-[0.68rem] text-muted">Sahaya companion</p>
          </div>
        </div>

        {/* Messages */}
        <div className="flex flex-col gap-2.5 py-4">
          {messages.map((m, i) => (
            <motion.div
              key={i}
              className={`bubble ${m.from === "user" ? "bubble-user" : "bubble-ai"}`}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.25 }}
            >
              {m.text}
            </motion.div>
          ))}
        </div>

        {children}
      </div>
    </PhoneFrame>
  );
}
