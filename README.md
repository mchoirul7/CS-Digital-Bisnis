# AI Customer Service untuk Distributor/Gudang

MVP ini membuktikan alur customer service AI yang dapat berbicara natural dalam bahasa Indonesia, tetapi semua fakta bisnis wajib berasal dari database atau business tool yang di-whitelist. Jika informasi belum tersedia, bot tidak boleh mengarang.

## Architecture

Empat lapisan dipisahkan tegas: pemahaman bahasa, memori percakapan, keputusan
bisnis, dan penjagaan fakta.

```text
Customer Message
  -> Gemini: semantic understanding (intent + entity + aksi draft)
  -> Conversation State (dibaca dari database, per conversation_id)
  -> Context Resolution (produk eksplisit > kandidat klarifikasi > produk yang
     pernah dibahas > activeProduct > baris draft)
  -> Deterministic Business Engine
       -> Product Resolver / Unit Resolver / Quantity Validator
       -> Draft Mutation (ADD/SET/INCREMENT/DECREMENT/REMOVE/RESTORE/CLEAR)
       -> Business Tools -> Supabase (stok, harga, rekening SELALU dibaca ulang)
  -> Structured Business Result
  -> Gemini: natural response candidate
  -> Business Guard
  -> Customer  (atau: Human Handoff -> Admin)
```

Gemini dipakai di ujung pertama (memahami bahasa) dan ujung terakhir (menyusun
kalimat). Gemini tidak pernah memutuskan produk mana yang dianggap sama, apakah
stok cukup, harga, total, konversi satuan, diskon, rekening, apakah pesanan boleh
diproses, atau apakah pembayaran sudah masuk. Angka dan satuan yang berasal dari
model selalu diverifikasi ada di pesan customer sebelum dipakai.

### Conversation State

`conversations.state` (JSONB) menyimpan memori percakapan, bukan fakta bisnis:
produk yang sedang dibahas, produk yang pernah dibahas, kandidat klarifikasi,
draft pesanan (produk + jumlah + satuan + status), dan fase pesanan. State
dibaca ulang dari database setiap request sehingga konteks bertahan di
lingkungan serverless; client hanya mengirim `message` dan `sessionId`.

Yang TIDAK pernah disimpan di state: stok, harga, total, rekening, dan
ketersediaan. Saat customer minta rangkuman, setiap baris draft divalidasi ulang
ke database.

### Human handoff

Percakapan punya kepemilikan: `AI_ACTIVE`, `HUMAN_PENDING`, `HUMAN_ACTIVE`,
`CLOSED`. Setiap kalimat "saya teruskan ke admin" berpasangan dengan baris
`human_handoffs` yang benar-benar tersimpan. Saat `HUMAN_ACTIVE`, pesan customer
tetap disimpan tetapi AI tidak menjawab sama sekali. Inbox admin ada di
`/admin/conversations`.

Layer utama:

- `src/lib/ai/intent-extractor.ts`: pesan customer menjadi structured request (skema Zod) - intent, secondary intents, entity produk, jumlah, satuan.
- `src/lib/ai/response-generator.ts`: menyusun bahasa dari business result, plus template deterministik sebagai fallback.
- `src/lib/chat/conversation-state.ts`: bentuk state, resolusi rujukan, dan aturan kapan `activeProduct` boleh berubah.
- `src/lib/business/product-resolver.ts`: pencocokan produk deterministik (`EXACT`, `FUZZY_SAFE`, `AMBIGUOUS`, `NOT_FOUND`).
- `src/lib/business/unit-resolver.ts`: `EXACT`, `CONVERTIBLE`, atau `NEEDS_CLARIFICATION`; tidak pernah mengarang konversi.
- `src/lib/business/draft.ts`: mutasi draft pesanan deterministik.
- `src/lib/business/business-engine.ts`: satu alur generik per intent, menghasilkan business result.
- `src/lib/business-tools/*`: akses data resmi (products, inventory, pricing, packaging, orders, payments, support) dengan pencatatan audit.
- `src/lib/business-guard`: membandingkan kalimat kandidat dengan business result sebelum dikirim.
- `src/lib/handoff`, `src/lib/admin`: handoff nyata, klaim atomik, dan inbox admin.

## Setup

Install dependency:

```bash
pnpm install
```

Copy env:

```bash
cp .env.example .env.local
```

Isi:

```text
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
DEFAULT_COMPANY_ID=11111111-1111-4111-8111-111111111111
ADMIN_API_TOKEN=...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash-lite
ENABLE_DEBUG_PANEL=false
```

`SUPABASE_SECRET_KEY` dipakai hanya di server. Jangan memakai `NEXT_PUBLIC_` untuk secret.
`DEFAULT_COMPANY_ID` wajib menunjuk baris `companies.id` yang aktif. Untuk local seed,
pakai `11111111-1111-4111-8111-111111111111`; untuk database hosted, isi dengan UUID
company production. `ADMIN_API_TOKEN` mengunci API `/api/admin/conversations`; di
production endpoint admin akan fail closed jika token ini belum diset.

## Supabase

Migration utama:

- `supabase/migrations/20260914105851_initial_schema.sql`

Schema minimal:

- `companies`
- `products`
- `inventory`
- `unit_conversions`
- `payment_accounts`
- `conversations`
- `messages`
- `human_handoffs`

Seed dummy:

- Company: `CV Maju Lancar`
- Company id default: `11111111-1111-4111-8111-111111111111`
- Produk: Indomie Goreng, Aqua 600 ml, Teh Botol, Gula Pasir 1 kg, Minyak Goreng 1 L
- Rekening development: `Bank Dummy Development 0000000000`

Migration mengaktifkan RLS pada seluruh tabel public dan tidak membuat policy
untuk `anon`/`authenticated`. Aplikasi membaca data bisnis lewat server-only
Supabase secret/service key, sehingga browser tidak mendapat akses langsung ke
tabel produk, stok, rekening, pesan, atau handoff.

Jalankan Supabase lokal:

```bash
pnpm dlx supabase@latest start
pnpm dlx supabase@latest db reset
```

Untuk project Supabase hosted:

```bash
pnpm dlx supabase@latest link --project-ref <project-ref>
pnpm dlx supabase@latest db push
```

## Gemini API

Buat API key di Google AI Studio, lalu simpan ke `GEMINI_API_KEY`. Default model memakai `gemini-3.5-flash-lite`. Jika key belum ada, aplikasi memakai parser deterministic, tetapi produk, stok, harga, dan rekening tetap wajib dibaca dari Supabase saat tool dipanggil.

Supabase runtime wajib tersedia. Jika `NEXT_PUBLIC_SUPABASE_URL` atau `SUPABASE_SECRET_KEY` tidak valid, aplikasi tidak memakai data dummy dan akan menjawab dengan fallback aman seperti `Maaf, data stok sedang tidak dapat diperiksa.`

## Menjalankan

Development:

```bash
pnpm dev
```

Buka `http://localhost:3000`.

Quality checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Deploy Vercel

1. Push repository ke Git provider.
2. Import ke Vercel sebagai Next.js app.
3. Tambahkan environment variable `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GEMINI_API_KEY`, dan opsional `GEMINI_MODEL`.
4. Tambahkan `DEFAULT_COMPANY_ID` sesuai baris `companies.id` production dan `ADMIN_API_TOKEN` untuk dashboard admin.
5. Jalankan migration/seed pada Supabase hosted.
6. Deploy.

## Guardrails

- Browser tidak menerima Gemini API key atau Supabase secret key.
- `company_id` ditentukan server-side melalui `DEFAULT_COMPANY_ID`, bukan input browser.
- API admin dikunci dengan `ADMIN_API_TOKEN` di production.
- Business facts single source of truth: `products`, `products.price`, `inventory.quantity`, dan `payment_accounts`.
- Runtime tidak memiliki mock, cache query, atau fallback data bisnis. Kegagalan database menghasilkan `DATA_UNAVAILABLE`.
- Conversation context hanya menyimpan identitas produk yang sedang dibahas, tidak pernah stok, harga, atau rekening.
- Product list mengambil produk aktif dari Supabase dengan company id server-side dan pagination.
- Varian dan ukuran adalah token signifikan: "Indomie Soto" tidak pernah diarahkan ke "Indomie Goreng", "Aqua 1.5 liter" tidak pernah ke "Aqua 600 ml".
- Typo ringan ditoleransi ("indomi goreng", "indomie gorng"), tetapi varian berbeda tidak.
- Beberapa kandidat yang masuk akal menghasilkan pertanyaan klarifikasi, bukan pilihan sepihak.
- Satuan customer tidak pernah diubah diam-diam. Tanpa data konversi resmi, sistem meminta klarifikasi.
- `quantity <= 0`, bukan angka, atau di luar batas ditolak sebelum kalkulasi apa pun.
- `quantity > stock` menghasilkan `INSUFFICIENT_STOCK` dengan `order_allowed = false`.
- Quote boleh dihitung walaupun stok kurang, tetapi hasilnya wajib menyatakan stok tidak mencukupi.
- MVP belum menyimpan record order, sehingga status maksimal adalah `READY_FOR_CONFIRMATION`.
- Business Guard memblokir angka jumlah, nominal, rekening, klaim ketersediaan, persetujuan order, persetujuan diskon, janji pengiriman, dan istilah internal yang tidak sesuai business result.
- Fallback ketika guard memblokir adalah template deterministik dari business result yang sama, bukan percobaan ulang ke model.

## Keterbatasan saat ini

- Tabel `unit_conversions` sudah tersedia, tetapi seed dummy belum mengisi data konversi. Tanpa baris konversi resmi, satuan di luar satuan inventory tetap menghasilkan pertanyaan klarifikasi.
- Belum ada persistence order, jadwal pengiriman, dan aturan diskon. Ketiganya diarahkan ke konfirmasi admin.
- Product resolver bekerja pada nama, SKU, dan deskripsi produk; sinonim lintas brand ("mie instan" ke merek tertentu) belum didukung.
