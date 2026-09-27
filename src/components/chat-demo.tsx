"use client";

import {
  CheckCheck,
  Loader2,
  MessageCircle,
  MessageCirclePlus,
  Mic,
  MoreVertical,
  Paperclip,
  RotateCcw,
  Send,
  Smile,
  UserRound,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationOwnership, MessageSender } from "@/lib/business-tools/types";

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  sender: MessageSender;
  content: string;
  createdAt?: string;
};

type ChatApiResponse = {
  reply?: string | null;
  ownership?: ConversationOwnership;
  error?: string;
};

type PollResponse = {
  ownership?: ConversationOwnership;
  messages?: Array<{
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    sender: MessageSender;
    content: string;
    created_at?: string;
  }>;
};

const SESSION_STORAGE_KEY = "cs-demo-session-id";

function starterMessage(): UiMessage {
  return {
    id: "starter",
    role: "assistant",
    sender: "AI",
    content: "Halo, Kak. Ada yang bisa saya bantu?",
  };
}

function createSessionId() {
  if (typeof window === "undefined") {
    return "server-session";
  }

  const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.localStorage.setItem(SESSION_STORAGE_KEY, next);
  return next;
}

function formatTime(value?: string) {
  if (!value) {
    return "";
  }

  const date = value ? new Date(value) : new Date();

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(".", ":");
}

function ownershipText(ownership: ConversationOwnership) {
  switch (ownership) {
    case "HUMAN_PENDING":
      return "menunggu admin";
    case "HUMAN_ACTIVE":
      return "sedang ditangani admin";
    case "CLOSED":
      return "percakapan ditutup";
    default:
      return "online";
  }
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="wa-bubble wa-bubble-in inline-flex items-center gap-1 px-4 py-3">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8696a0]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8696a0] [animation-delay:120ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#8696a0] [animation-delay:240ms]" />
      </div>
    </div>
  );
}

export function ChatDemo() {
  const [messages, setMessages] = useState<UiMessage[]>(() => [starterMessage()]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(() => createSessionId());
  const [ownership, setOwnership] = useState<ConversationOwnership>("AI_ACTIVE");
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  const subtitle = useMemo(() => ownershipText(ownership), [ownership]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/chat/messages?sessionId=${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as PollResponse;

      if (data.ownership) {
        setOwnership(data.ownership);
      }

      const serverMessages = (data.messages ?? []).filter(
        (message) => message.role === "user" || message.role === "assistant",
      );

      if (serverMessages.length === 0) {
        return;
      }

      setMessages(
        serverMessages.map((message) => ({
          id: message.id,
          role: message.role === "user" ? "user" : "assistant",
          sender: message.sender,
          content: message.content,
          createdAt: message.created_at,
        })),
      );
    } catch {
      // Polling admin/customer messages is best-effort.
    }
  }, [sessionId]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refresh();
    }, 0);
    const timer = window.setInterval(() => {
      void refresh();
    }, 4000);

    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeMenu(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      setMenuOpen(false);
    }

    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [menuOpen]);

  async function resetCurrentSession() {
    setMenuOpen(false);
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/chat/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, action: "reset" }),
      });

      const payload: unknown = await response.json();

      if (!response.ok || typeof payload !== "object" || payload === null) {
        throw new Error("Session belum bisa direset.");
      }

      const data = payload as ChatApiResponse;
      setMessages([starterMessage()]);
      setInput("");
      setOwnership(data.ownership ?? "AI_ACTIVE");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Session belum bisa direset.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function startNewChat() {
    const next = crypto.randomUUID();
    window.localStorage.setItem(SESSION_STORAGE_KEY, next);
    setMenuOpen(false);
    setSessionId(next);
    setMessages([starterMessage()]);
    setInput("");
    setOwnership("AI_ACTIVE");
    setError(null);
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = input.trim();
    if (!trimmed || loading) {
      return;
    }

    const userMessage: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      sender: "CUSTOMER",
      content: trimmed,
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, sessionId }),
      });

      const payload: unknown = await response.json();

      if (!response.ok || typeof payload !== "object" || payload === null) {
        throw new Error("Respons chat tidak valid.");
      }

      const data = payload as ChatApiResponse;

      if (data.ownership) {
        setOwnership(data.ownership);
      }

      if (data.reply) {
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            sender: "AI",
            content: data.reply as string,
            createdAt: new Date().toISOString(),
          },
        ]);
      } else if (data.error) {
        throw new Error(data.error);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Terjadi kesalahan.";
      setError(message);
    } finally {
      setLoading(false);
      void refresh();
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
      {!isOpen ? (
        <button type="button" onClick={() => setIsOpen(true)} className="helpdesk-launcher" aria-label="Buka chat customer service" title="Buka chat customer service">
          <MessageCircle className="h-6 w-6" aria-hidden="true" />
          <span className="hidden sm:inline">Butuh bantuan?</span>
        </button>
      ) : null}
      {isOpen ? (
        <section className="helpdesk-panel flex flex-col overflow-hidden bg-[#efeae2] text-[#111b21]">
      <header className="flex h-[58px] shrink-0 items-center justify-between bg-[#167b67] px-3 text-white shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#dfe5e7] text-[#54656f]">
            <UserRound className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[16px] font-medium leading-5 tracking-normal">CV Maju Lancar</h1>
            <p className="truncate text-[13px] leading-4 text-white/80">{subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((current) => !current)}
              className="wa-header-icon"
              aria-label="Menu session"
              aria-expanded={menuOpen}
            >
              <MoreVertical className="h-5 w-5" aria-hidden="true" />
            </button>

            {menuOpen ? (
              <div className="absolute right-0 top-11 z-20 w-52 overflow-hidden rounded-sm bg-white py-2 text-[#111b21] shadow-[0_2px_10px_rgba(11,20,26,0.22)]">
                <button
                  type="button"
                  onClick={resetCurrentSession}
                  disabled={loading}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-[14.5px] hover:bg-[#f5f6f6] disabled:opacity-60"
                >
                  <RotateCcw className="h-5 w-5 text-[#54656f]" aria-hidden="true" />
                  Reset session
                </button>
                <button
                  type="button"
                  onClick={startNewChat}
                  disabled={loading}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-[14.5px] hover:bg-[#f5f6f6] disabled:opacity-60"
                >
                  <MessageCirclePlus className="h-5 w-5 text-[#54656f]" aria-hidden="true" />
                  Session baru
                </button>
              </div>
            ) : null}
          </div>
          <button type="button" onClick={() => setIsOpen(false)} className="wa-header-icon" aria-label="Tutup chat" title="Tutup chat">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="wa-chat-wallpaper flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-[9%]">
          <div className="flex flex-col gap-1.5">
            {messages.map((message) => {
              const isUser = message.role === "user";
              const isAdmin = message.sender === "ADMIN";

              return (
                <div key={message.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div className={`wa-bubble ${isUser ? "wa-bubble-out" : "wa-bubble-in"}`}>
                    {isAdmin ? <div className="mb-1 text-[12px] font-medium text-[#128c7e]">Admin</div> : null}
                    <div className="whitespace-pre-wrap break-words pr-12 text-[14.2px] leading-[19px]">
                      {message.content}
                    </div>
                    <div
                      className={`absolute bottom-1 right-2 flex items-center gap-1 text-[11px] leading-none ${
                        isUser ? "text-[#667781]" : "text-[#667781]"
                      }`}
                    >
                      <span>{formatTime(message.createdAt)}</span>
                      {isUser ? <CheckCheck className="h-4 w-4 text-[#53bdeb]" aria-hidden="true" /> : null}
                    </div>
                  </div>
                </div>
              );
            })}

            {loading ? <TypingBubble /> : null}
            <div ref={endRef} />
          </div>
        </div>

        {error ? (
          <div className="mx-3 mb-2 rounded-lg bg-[#fff3cd] px-3 py-2 text-[13px] text-[#664d03] sm:mx-[9%]">
            {error}
          </div>
        ) : null}

        <form onSubmit={submitMessage} className="flex min-h-[62px] shrink-0 items-center gap-2 bg-[#f0f2f5] px-2 py-2">
          <button type="button" className="wa-input-icon" aria-label="Emoji">
            <Smile className="h-6 w-6" aria-hidden="true" />
          </button>
          <button type="button" className="wa-input-icon" aria-label="Lampiran">
            <Paperclip className="h-6 w-6" aria-hidden="true" />
          </button>

          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ketik pesan"
            disabled={loading}
            className="h-[42px] min-w-0 flex-1 rounded-full border-0 bg-white px-4 text-[15px] text-[#111b21] outline-none placeholder:text-[#667781]"
          />

          <button
            type={input.trim() ? "submit" : "button"}
            disabled={loading}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white transition active:scale-95 disabled:opacity-70"
            aria-label={input.trim() ? "Kirim" : "Pesan suara"}
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : input.trim() ? (
              <Send className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Mic className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </form>
      </div>
        </section>
      ) : null}
    </div>
  );
}
