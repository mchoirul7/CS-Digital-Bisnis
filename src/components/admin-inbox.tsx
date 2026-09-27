"use client";

import { Loader2, RefreshCw, Send } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import type { AdminInbox, AdminInboxItem } from "@/lib/admin/service";
import type { ConversationOwnership, MessageSender } from "@/lib/business-tools/types";

type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  sender: MessageSender;
  content: string;
  created_at: string;
};

type ConversationDetail = {
  conversation: { id: string; session_id: string; ownership: ConversationOwnership };
  messages: ConversationMessage[];
};

const emptyInbox: AdminInbox = { pending: [], active: [], done: [] };
const ADMIN_TOKEN_STORAGE_KEY = "cs-admin-token";

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("id-ID");
}

function senderLabel(message: ConversationMessage) {
  if (message.role === "user") {
    return "Customer";
  }

  return message.sender === "ADMIN" ? "Admin" : "AI";
}

function InboxCard({
  item,
  selected,
  onSelect,
  onClaim,
  busy,
}: {
  item: AdminInboxItem;
  selected: boolean;
  onSelect: () => void;
  onClaim?: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border px-3 py-3 text-left transition ${
        selected ? "border-teal-500 bg-teal-50" : "border-neutral-200 bg-white hover:border-teal-300"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-neutral-950">{item.reason_label}</span>
        <span className="text-[11px] text-neutral-500">{formatTime(item.created_at)}</span>
      </div>
      <div className="mt-1 text-[11px] text-neutral-500">Sesi {item.session_id.slice(0, 8)}</div>
      {item.active_product ? (
        <div className="mt-1 text-[11px] text-neutral-600">Produk: {item.active_product}</div>
      ) : null}
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-neutral-700">{item.summary}</p>
      {item.last_customer_message ? (
        <p className="mt-2 rounded bg-neutral-100 px-2 py-1 text-[11px] text-neutral-700">
          &quot;{item.last_customer_message}&quot;
        </p>
      ) : null}
      {onClaim ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onClaim();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
              onClaim();
            }
          }}
          className="mt-3 inline-flex items-center rounded bg-teal-700 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-teal-800"
          aria-disabled={busy}
        >
          Ambil Percakapan
        </span>
      ) : null}
    </button>
  );
}

export function AdminInboxView() {
  const [inbox, setInbox] = useState<AdminInbox>(emptyInbox);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [reply, setReply] = useState("");
  const [adminToken, setAdminToken] = useState(() =>
    typeof window === "undefined" ? "" : (window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? ""),
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const adminHeaders = useCallback(
    (token = adminToken) => (token ? { "x-admin-token": token } : undefined),
    [adminToken],
  );

  const handleAuthFailure = useCallback(async (response: Response) => {
    if (response.status !== 401 && response.status !== 503) {
      return false;
    }

    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    setAuthRequired(true);
    setNotice(payload?.error ?? "Akses admin perlu token.");
    return true;
  }, []);

  const loadInbox = useCallback(async (token = adminToken) => {
    const response = await fetch("/api/admin/conversations", { headers: adminHeaders(token) });
    if (await handleAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      return;
    }
    setAuthRequired(false);
    setNotice(null);
    setInbox((await response.json()) as AdminInbox);
  }, [adminHeaders, adminToken, handleAuthFailure]);

  const loadDetail = useCallback(async (conversationId: string, token = adminToken) => {
    const response = await fetch(
      `/api/admin/conversations?conversationId=${encodeURIComponent(conversationId)}`,
      { headers: adminHeaders(token) },
    );
    if (await handleAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      return;
    }
    setDetail((await response.json()) as ConversationDetail);
  }, [adminHeaders, adminToken, handleAuthFailure]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void loadInbox();
    }, 0);
    const timer = window.setInterval(() => {
      void loadInbox();
      if (selectedId) {
        void loadDetail(selectedId);
      }
    }, 4000);

    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadInbox, loadDetail, selectedId]);

  async function act(body: Record<string, unknown>, successMessage: string) {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/admin/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(adminHeaders() ?? {}) },
        body: JSON.stringify(body),
      });

      if (await handleAuthFailure(response)) {
        return false;
      }

      const payload = (await response.json()) as { ok?: boolean; reason?: string };

      if (!response.ok || !payload.ok) {
        setNotice(
          payload.reason === "ALREADY_CLAIMED"
            ? "Percakapan sudah diambil admin lain."
            : `Aksi gagal${payload.reason ? `: ${payload.reason}` : "."}`,
        );
        return false;
      }

      setNotice(successMessage);
      return true;
    } finally {
      setBusy(false);
      await loadInbox();
      if (selectedId) {
        await loadDetail(selectedId);
      }
    }
  }

  const selectedItem =
    [...inbox.pending, ...inbox.active, ...inbox.done].find(
      (item) => item.conversation_id === selectedId,
    ) ?? null;

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedId || !reply.trim()) {
      return;
    }

    const ok = await act(
      { action: "reply", conversationId: selectedId, text: reply.trim() },
      "Balasan terkirim.",
    );

    if (ok) {
      setReply("");
    }
  }

  function select(item: AdminInboxItem) {
    setSelectedId(item.conversation_id);
    void loadDetail(item.conversation_id);
  }

  async function submitAdminToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const token = adminToken.trim();
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    setNotice(null);
    await loadInbox(token);
  }

  if (authRequired) {
    return (
      <section className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-950">Inbox Admin</h1>
          <p className="mt-1 text-sm text-neutral-600">Masukkan token admin untuk membuka percakapan.</p>
        </div>
        {notice ? (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {notice}
          </div>
        ) : null}
        <form onSubmit={submitAdminToken} className="flex gap-2">
          <input
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            type="password"
            placeholder="Token admin"
            className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-teal-700"
          />
          <button
            type="submit"
            className="rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
          >
            Buka
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col gap-4">
      <header className="flex items-center justify-between border-b border-neutral-300 pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-950">Inbox Admin</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Percakapan yang diserahkan AI karena butuh keputusan manusia.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadInbox()}
          className="inline-flex items-center gap-2 rounded border border-neutral-300 bg-white px-3 py-2 text-xs font-medium text-neutral-700 transition hover:border-teal-300"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Muat ulang
        </button>
      </header>

      {notice ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {notice}
        </div>
      ) : null}

      <div className="grid flex-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-5 overflow-y-auto">
          {(
            [
              ["Perlu ditangani", inbox.pending, true],
              ["Sedang ditangani", inbox.active, false],
              ["Selesai", inbox.done, false],
            ] as const
          ).map(([title, items, claimable]) => (
            <div key={title}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {title} ({items.length})
              </div>
              <div className="space-y-2">
                {items.length === 0 ? (
                  <p className="rounded border border-dashed border-neutral-300 px-3 py-4 text-xs text-neutral-500">
                    Belum ada.
                  </p>
                ) : null}
                {items.map((item) => (
                  <InboxCard
                    key={item.handoff_id}
                    item={item}
                    selected={item.conversation_id === selectedId}
                    onSelect={() => select(item)}
                    busy={busy}
                    onClaim={
                      claimable
                        ? () =>
                            void act(
                              { action: "claim", handoffId: item.handoff_id },
                              "Percakapan berhasil diambil.",
                            )
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex min-h-[30rem] flex-col rounded-md border border-neutral-300 bg-white">
          {!detail ? (
            <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
              Pilih satu percakapan di kiri.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-neutral-950">
                    Sesi {detail.conversation.session_id.slice(0, 8)}
                  </div>
                  <div className="text-xs text-neutral-500">Status: {detail.conversation.ownership}</div>
                </div>
                {selectedItem && selectedItem.status === "ACTIVE" ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          { action: "return_to_ai", handoffId: selectedItem.handoff_id },
                          "Percakapan dikembalikan ke AI.",
                        )
                      }
                      className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:border-teal-300"
                    >
                      Kembalikan ke AI
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          { action: "close", handoffId: selectedItem.handoff_id },
                          "Percakapan ditutup.",
                        )
                      }
                      className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-neutral-800"
                    >
                      Selesaikan
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {detail.messages.map((message) => (
                  <div
                    key={message.id}
                    className={message.role === "user" ? "flex justify-start" : "flex justify-end"}
                  >
                    <div className="max-w-[80%]">
                      <div className="mb-1 text-[11px] font-semibold text-neutral-500">
                        {senderLabel(message)}
                      </div>
                      <div
                        className={`rounded-md px-3 py-2 text-sm leading-6 ${
                          message.role === "user"
                            ? "border border-neutral-200 bg-neutral-50 text-neutral-900"
                            : message.sender === "ADMIN"
                              ? "bg-teal-700 text-white"
                              : "border border-neutral-200 bg-white text-neutral-900"
                        }`}
                      >
                        {message.content}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <form onSubmit={submitReply} className="border-t border-neutral-200 p-3">
                {detail.conversation.ownership !== "HUMAN_ACTIVE" ? (
                  <p className="text-xs text-neutral-500">
                    Ambil percakapan dulu sebelum membalas customer.
                  </p>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      placeholder="Balas sebagai admin..."
                      className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-teal-700"
                      disabled={busy}
                    />
                    <button
                      type="submit"
                      disabled={busy || !reply.trim()}
                      className="inline-flex h-10 items-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-neutral-300"
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Send className="h-4 w-4" aria-hidden="true" />
                      )}
                      Kirim
                    </button>
                  </div>
                )}
              </form>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
