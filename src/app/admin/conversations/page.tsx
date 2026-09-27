import { AdminInboxView } from "@/components/admin-inbox";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function AdminConversationsPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-5 sm:px-6 lg:px-8">
      <Link href="/admin/orders" className="mb-4 self-end text-sm text-teal-300 underline">Pesanan</Link>
      <AdminInboxView />
    </main>
  );
}
