"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, MessageSquare, PackageCheck, Play, RefreshCw, X } from "lucide-react";
import type { Order, OrderDetail, OrderStatus } from "@/lib/business-tools/order-types";
import { formatRupiah } from "@/lib/utils/format";

const labels: Record<OrderStatus, string> = { draft: "Draft", confirmed: "Dikonfirmasi", processing: "Diproses", completed: "Selesai", cancelled: "Dibatalkan" };
const colors: Record<OrderStatus, string> = { draft: "text-neutral-600", confirmed: "text-teal-700", processing: "text-amber-700", completed: "text-green-700", cancelled: "text-red-700" };
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded border border-neutral-300 bg-white px-3 text-sm hover:bg-neutral-100 disabled:opacity-40";

export function AdminOrders() {
  const [token, setToken] = useState("");
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmAction, setConfirmAction] = useState<"completed" | "cancelled" | null>(null);
  const selection = useRef(0);

  const api = useCallback(async (query = "", body?: unknown) => {
    const response = await fetch(`/api/admin/orders${query}`, {
      method: body ? "POST" : "GET", headers: { "x-admin-token": activeToken ?? "", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Permintaan gagal.");
    return data;
  }, [activeToken]);

  const refresh = useCallback(async () => {
    if (activeToken === null) return;
    setBusy(true); setError("");
    try { setOrders((await api(`?status=${status}&offset=${offset}`)).orders); }
    catch (error) { setError(error instanceof Error ? error.message : "Pesanan belum bisa dibaca."); }
    finally { setBusy(false); }
  }, [activeToken, api, status, offset]);

  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    return () => { window.clearTimeout(initial); };
  }, [refresh]);

  async function openOrder(id: string) {
    const request = ++selection.current;
    setBusy(true); setError(""); setDetail(null); setConfirmAction(null);
    try { const data = await api(`?id=${id}`); if (request === selection.current) setDetail(data.order); }
    catch (error) { setError(error instanceof Error ? error.message : "Pesanan belum bisa dibaca."); }
    finally { setBusy(false); }
  }

  async function changeStatus(next: OrderStatus) {
    if (!detail) return;
    setBusy(true); setError("");
    try {
      setDetail((await api("", { orderId: detail.id, status: next })).order);
      setConfirmAction(null); await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Perubahan gagal."); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
    <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 pb-5">
      <h1 className="flex items-center gap-3 text-2xl font-semibold"><PackageCheck className="text-teal-700" />Pesanan</h1>
      <Link className={button} href="/admin/conversations"><MessageSquare size={16} />Percakapan</Link>
    </header>
    <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); setActiveToken(token); }}>
      <label className="flex min-w-0 flex-col gap-1 text-sm">Token admin
        <input type="password" autoComplete="off" className="h-10 max-w-full rounded border border-neutral-300 bg-white px-3" value={token} onChange={(event) => setToken(event.target.value)} />
      </label>
      <button className={button} type="submit"><Check size={16} />Masuk</button>
    </form>
    {error && <p role="alert" className="mb-4 border-l-4 border-red-500 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {activeToken !== null && <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <select aria-label="Status pesanan" className="h-10 rounded border border-neutral-300 bg-white px-3 text-sm" value={status} disabled={busy} onChange={(event) => { setStatus(event.target.value); setOffset(0); setDetail(null); }}>
          <option value="">Semua status</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <button className={button} title="Muat ulang" aria-label="Muat ulang" disabled={busy} onClick={() => { setDetail(null); void refresh(); }}>{busy ? <Loader2 className="animate-spin" size={17} /> : <RefreshCw size={17} />}</button>
      </div>
      <div className="overflow-x-auto border-y border-neutral-200">
        <table className="w-full min-w-[540px] text-left text-sm"><thead className="bg-neutral-100 text-neutral-600"><tr>{["Nomor pesanan", "Tanggal", "Status", "Total"].map((name) => <th key={name} className="px-3 py-3 font-medium">{name}</th>)}</tr></thead>
          <tbody>{orders.map((order) => <tr key={order.id} className={`border-t border-neutral-200 ${detail?.id === order.id ? "bg-teal-50" : "bg-white"}`}>
            <td className="px-3 py-3"><button disabled={busy} className="text-left font-medium text-teal-800 underline-offset-4 hover:underline" onClick={() => void openOrder(order.id)}>{order.order_number}</button></td>
            <td className="px-3 py-3">{new Date(order.created_at).toLocaleDateString("id-ID")}</td>
            <td className={`px-3 py-3 font-medium ${colors[order.status]}`}>{labels[order.status]}</td><td className="whitespace-nowrap px-3 py-3">{formatRupiah(order.total)}</td>
          </tr>)}</tbody>
        </table>
        {!orders.length && <p className="bg-white px-3 py-8 text-center text-sm text-neutral-500">{busy ? "Memuat pesanan..." : "Belum ada pesanan."}</p>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className={button} aria-label="Halaman sebelumnya" title="Halaman sebelumnya" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ArrowLeft size={16} /></button>
        <button className={button} aria-label="Halaman berikutnya" title="Halaman berikutnya" disabled={busy || orders.length < 50} onClick={() => setOffset(offset + 50)}><ArrowRight size={16} /></button>
      </div>
      {detail && <section className="mt-8 border-t border-neutral-300 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="break-all text-lg font-semibold">{detail.order_number}</h2><span className={`text-sm font-medium ${colors[detail.status]}`}>{labels[detail.status]}</span></div>
        <p className="my-3 break-words text-sm text-neutral-600">{detail.customer?.name ?? "Pelanggan chat"}{detail.customer?.phone ? ` | ${detail.customer.phone}` : ""}</p>
        <div className="overflow-x-auto"><table className="w-full min-w-[400px] text-left text-sm"><thead><tr>{["Produk", "Jumlah", "Harga", "Subtotal"].map((name) => <th key={name} className="border-b py-2 pr-4 font-medium">{name}</th>)}</tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td className="py-3 pr-4">{item.product_name}</td><td className="whitespace-nowrap pr-4">{item.quantity} {item.unit}</td><td className="whitespace-nowrap pr-4">{formatRupiah(item.unit_price)}</td><td className="whitespace-nowrap">{formatRupiah(item.subtotal)}</td></tr>)}</tbody></table></div>
        <p className="border-t py-4 text-right font-semibold">Total {formatRupiah(detail.total)}</p>
        {detail.notes && <p className="mb-4 text-sm">{detail.notes}</p>}
        {(detail.status === "confirmed" || detail.status === "processing") && <div className="flex flex-wrap gap-2">
          {detail.status === "confirmed" && <button className={button} disabled={busy} onClick={() => void changeStatus("processing")}><Play size={16} />Proses</button>}
          <button className={button} disabled={busy} onClick={() => setConfirmAction("completed")}><Check size={16} />Selesaikan</button>
          <button className={`${button} text-red-700`} disabled={busy} onClick={() => setConfirmAction("cancelled")}><X size={16} />Batalkan</button>
        </div>}
        {confirmAction && <div className="mt-4 border-l-4 border-amber-500 bg-amber-50 p-4"><p className="mb-3 text-sm">{confirmAction === "completed" ? "Selesaikan pesanan dan catat stok keluar?" : "Batalkan pesanan dan lepaskan stok yang dipesan?"}</p><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void changeStatus(confirmAction)}><Check size={16} />Konfirmasi</button><button className={button} disabled={busy} onClick={() => setConfirmAction(null)}><X size={16} />Kembali</button></div></div>}
      </section>}
    </>}
  </div>;
}
