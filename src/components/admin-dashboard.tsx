"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Loader2,
  LockKeyhole,
  MessageSquareMore,
  PackageSearch,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FormEvent, useCallback, useMemo, useState } from "react";
import { formatRupiah } from "@/lib/utils/format";

type InventoryRow = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  price: number;
  active: boolean;
  on_hand: number;
  reserved: number;
  available: number;
};

type Transaction = {
  id: string;
  order_number: string;
  created_at: string;
  status: "draft" | "confirmed" | "processing" | "completed" | "cancelled";
  total: number;
};

type DashboardData = {
  inventory: InventoryRow[];
  transactions: Transaction[];
  inbox: { pending: unknown[]; active: unknown[]; done: unknown[] };
  summary: { products: number; low_stock: number; transactions: number; conversations: number };
};

type SummaryCard = {
  label: string;
  value: number;
  icon: LucideIcon;
  detail: string;
};

const statusLabel: Record<Transaction["status"], string> = {
  draft: "Draft",
  confirmed: "Siap diproses",
  processing: "Sedang diproses",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    .format(new Date(value))
    .replace(".", ":");
}

export function AdminDashboard() {
  const [token, setToken] = useState("");
  const [activeToken, setActiveToken] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (authorization = activeToken) => {
    if (!authorization) return;

    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/dashboard", { headers: { "x-admin-token": authorization } });
      const payload = (await response.json()) as DashboardData & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Dashboard belum bisa dimuat.");
      setData(payload);
    } catch (caught) {
      setData(null);
      setError(caught instanceof Error ? caught.message : "Dashboard belum bisa dimuat.");
    } finally {
      setBusy(false);
    }
  }, [activeToken]);

  const filteredInventory = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("id-ID");
    if (!normalized) return data?.inventory ?? [];
    return (data?.inventory ?? []).filter((item) =>
      `${item.name} ${item.sku}`.toLocaleLowerCase("id-ID").includes(normalized),
    );
  }, [data, query]);

  function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextToken = token.trim();
    setActiveToken(nextToken);
    void refresh(nextToken);
  }

  return (
    <main className="admin-shell min-h-screen pb-28 text-[#1f2933]">
      <header className="border-b border-[#dce4e1] bg-white">
        <div className="mx-auto flex min-h-16 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-7 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#167b67] text-white"><Boxes size={19} /></div>
            <div className="min-w-0"><p className="text-[15px] font-semibold">Ruang Operasi</p><p className="truncate text-xs text-[#66756f]">Master barang dan layanan pelanggan</p></div>
          </div>
          <nav className="hidden items-center gap-1 text-sm sm:flex">
            <a className="admin-nav-active" href="#ringkasan">Ringkasan</a>
            <a className="admin-nav" href="#inventaris">Inventaris</a>
            <a className="admin-nav" href="#transaksi">Transaksi</a>
            <Link className="admin-nav" href="/admin/conversations">Inbox</Link>
          </nav>
          <Link href="/admin/orders" className="inline-flex h-9 items-center gap-2 rounded-md border border-[#cbd7d2] px-3 text-sm font-medium hover:bg-[#f3f7f5]"><ClipboardList size={16} />Pesanan</Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-4 py-7 sm:px-7 lg:px-10 lg:py-9">
        <section id="ringkasan" className="flex flex-col justify-between gap-5 border-b border-[#dce4e1] pb-7 lg:flex-row lg:items-end">
          <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#167b67]">Dashboard admin</p><h1 className="text-2xl font-semibold tracking-normal text-[#17241f] sm:text-3xl">Pantau pekerjaan hari ini</h1><p className="mt-2 max-w-xl text-sm leading-6 text-[#66756f]">Kelola ketersediaan barang dan selesaikan transaksi yang masuk dari chat pelanggan.</p></div>
          <form onSubmit={submitToken} className="flex w-full max-w-md gap-2 lg:w-auto">
            <label className="relative min-w-0 flex-1"><LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#71807a]" /><input value={token} onChange={(event) => setToken(event.target.value)} type="password" placeholder="Token admin" className="h-10 w-full rounded-md border border-[#cbd7d2] bg-white pl-9 pr-3 text-sm outline-none placeholder:text-[#8c9994] focus:border-[#167b67]" /></label>
            <button type="submit" className="inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-[#167b67] px-4 text-sm font-medium text-white hover:bg-[#126957]">Muat data</button>
          </form>
        </section>

        {error ? <p role="alert" className="mt-5 border-l-4 border-[#d14a43] bg-[#fff1ef] px-4 py-3 text-sm text-[#8f2e29]">{error}</p> : null}

        {!data ? (
          <section className="grid min-h-80 place-items-center border-b border-[#dce4e1] py-12 text-center"><div><div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#e5f2ed] text-[#167b67]">{busy ? <Loader2 className="animate-spin" /> : <PackageSearch />}</div><h2 className="text-lg font-semibold text-[#17241f]">Data operasional siap dimuat</h2><p className="mt-2 max-w-sm text-sm leading-6 text-[#66756f]">Masukkan token admin untuk melihat stok aktual dan antrean yang perlu ditangani.</p></div></section>
        ) : <>
          <section className="grid gap-px overflow-hidden border border-[#dce4e1] bg-[#dce4e1] sm:grid-cols-2 xl:grid-cols-4">
            {([
              { label: "Barang aktif", value: data.summary.products, icon: Boxes, detail: "Master produk tersedia" },
              { label: "Stok perlu perhatian", value: data.summary.low_stock, icon: AlertTriangle, detail: "Ketersediaan 10 atau kurang" },
              { label: "Transaksi berjalan", value: data.summary.transactions, icon: TrendingUp, detail: "Draft, siap proses, diproses" },
              { label: "Chat perlu respons", value: data.summary.conversations, icon: MessageSquareMore, detail: "Menunggu atau ditangani CS" },
            ] satisfies SummaryCard[]).map(({ label, value, icon: Icon, detail }) => <div key={label} className="min-h-32 bg-white p-5"><div className="mb-5 flex items-start justify-between"><p className="text-sm font-medium text-[#53615b]">{label}</p><Icon className="h-5 w-5 text-[#167b67]" /></div><p className="text-3xl font-semibold text-[#17241f]">{value}</p><p className="mt-1 text-xs text-[#75827c]">{detail}</p></div>)}
          </section>

          <section id="inventaris" className="pt-9"><div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-lg font-semibold text-[#17241f]">Master barang dan stok</h2><p className="mt-1 text-sm text-[#66756f]">Stok tersedia sudah dikurangi barang yang direservasi.</p></div><div className="flex gap-2"><label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#71807a]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari SKU atau barang" className="h-10 w-full rounded-md border border-[#cbd7d2] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#167b67] sm:w-56" /></label><button type="button" onClick={() => void refresh()} title="Muat ulang" aria-label="Muat ulang" className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#cbd7d2] bg-white text-[#486158] hover:bg-[#f3f7f5]">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</button></div></div>
            <div className="overflow-x-auto border-y border-[#dce4e1]"><table className="w-full min-w-[720px] text-left text-sm"><thead className="bg-[#f4f7f5] text-xs uppercase tracking-[0.06em] text-[#68766f]"><tr><th className="px-4 py-3 font-medium">Barang</th><th className="px-4 py-3 font-medium">SKU</th><th className="px-4 py-3 font-medium text-right">Stok fisik</th><th className="px-4 py-3 font-medium text-right">Reservasi</th><th className="px-4 py-3 font-medium text-right">Tersedia</th><th className="px-4 py-3 font-medium">Status</th></tr></thead><tbody>{filteredInventory.map((item) => { const low = item.available <= 10; return <tr key={item.id} className="border-t border-[#e7ece9] bg-white"><td className="px-4 py-4 font-medium text-[#1f2933]">{item.name}<p className="mt-0.5 text-xs font-normal text-[#75827c]">{formatRupiah(item.price)} / {item.unit}</p></td><td className="px-4 py-4 font-mono text-xs text-[#66756f]">{item.sku}</td><td className="px-4 py-4 text-right tabular-nums">{item.on_hand} {item.unit}</td><td className="px-4 py-4 text-right tabular-nums text-[#7b6350]">{item.reserved}</td><td className="px-4 py-4 text-right font-semibold tabular-nums">{item.available} {item.unit}</td><td className="px-4 py-4"><span className={low ? "stock-warning" : "stock-ok"}>{low ? "Perlu isi ulang" : "Aman"}</span></td></tr>; })}</tbody></table>{!filteredInventory.length ? <p className="bg-white px-4 py-10 text-center text-sm text-[#75827c]">Barang tidak ditemukan.</p> : null}</div>
          </section>

          <section id="transaksi" className="grid gap-8 border-t border-[#dce4e1] pt-9 lg:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.8fr)]"><div><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-semibold text-[#17241f]">Transaksi perlu diproses</h2><p className="mt-1 text-sm text-[#66756f]">Urutkan pekerjaan berdasarkan status transaksi.</p></div><Link href="/admin/orders" className="inline-flex items-center gap-1 text-sm font-medium text-[#167b67] hover:underline">Lihat semua <ArrowUpRight size={15} /></Link></div><div className="divide-y divide-[#e2e9e5] border-y border-[#dce4e1]">{data.transactions.slice(0, 6).map((transaction) => <Link href="/admin/orders" key={transaction.id} className="flex items-center justify-between gap-4 bg-white px-4 py-4 transition hover:bg-[#f4f8f6]"><div className="min-w-0"><p className="font-medium text-[#1f2933]">{transaction.order_number}</p><p className="mt-1 text-xs text-[#75827c]">{formatDate(transaction.created_at)}</p></div><div className="flex shrink-0 items-center gap-5"><span className={`transaction-${transaction.status}`}>{statusLabel[transaction.status]}</span><p className="hidden text-sm font-medium tabular-nums text-[#1f2933] sm:block">{formatRupiah(transaction.total)}</p><ArrowUpRight className="h-4 w-4 text-[#7a8781]" /></div></Link>)}{!data.transactions.length ? <div className="bg-white px-4 py-10 text-center text-sm text-[#75827c]"><CheckCircle2 className="mx-auto mb-2 h-5 w-5 text-[#167b67]" />Tidak ada transaksi yang perlu diproses.</div> : null}</div></div><aside className="border-t border-[#dce4e1] pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0"><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#167b67]">Pusat bantuan</p><h2 className="mt-2 text-lg font-semibold text-[#17241f]">Pesan pelanggan tetap masuk via chat</h2><p className="mt-2 text-sm leading-6 text-[#66756f]">Gunakan widget CS di pojok kanan bawah untuk memulai percakapan. Handoff yang masuk dapat dikelola dari Inbox admin.</p><Link href="/admin/conversations" className="mt-5 inline-flex h-10 items-center gap-2 rounded-md border border-[#cbd7d2] px-3 text-sm font-medium hover:bg-[#f3f7f5]"><MessageSquareMore size={16} />Buka inbox</Link></aside></section>
        </>}
      </div>
    </main>
  );
}
