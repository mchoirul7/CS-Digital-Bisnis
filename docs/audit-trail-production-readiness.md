# Production Readiness Audit Trail

Tanggal audit: 2026-09-14

## Ringkasan

Audit difokuskan pada kasus berulang yang bisa membuat produk tidak layak dijual:
database baru tidak sama dengan database developer, tenant/company salah arah,
admin handoff terbuka tanpa proteksi, dan fakta bisnis tidak punya jejak resmi.

## Temuan Dan Perbaikan

1. Migration database kosong

   Dampak: `supabase db reset` atau deploy ke project Supabase baru tidak bisa
   membentuk tabel yang dibutuhkan aplikasi. Akibatnya runtime mudah jatuh ke
   `DATA_UNAVAILABLE` walaupun kode dan seed terlihat benar.

   Perbaikan: menambahkan migration
   `supabase/migrations/20260914105851_initial_schema.sql` yang membuat tabel
   `companies`, `products`, `inventory`, `unit_conversions`,
   `payment_accounts`, `conversations`, `messages`, dan `human_handoffs`.
   Migration juga menambahkan primary key, foreign key, unique constraint,
   index lookup, check constraint status, dan partial unique index agar satu
   conversation hanya punya satu handoff terbuka.

2. Company id seed tidak sama dengan runtime

   Dampak: seed lokal mengisi company `11111111-1111-4111-8111-111111111111`,
   tetapi runtime sebelumnya menunjuk UUID lain. Database terlihat berisi data,
   tetapi aplikasi tetap gagal menemukan default company.

   Perbaikan: `DEFAULT_COMPANY_ID` sekarang bisa diatur lewat env. Fallback-nya
   disamakan dengan seed lokal, dan test menutup regresi fallback/override.

3. API admin tidak dikunci

   Dampak: inbox admin, klaim handoff, pesan admin, dan close/return-to-AI bisa
   dipanggil tanpa autentikasi endpoint.

   Perbaikan: menambahkan `ADMIN_API_TOKEN` untuk `/api/admin/conversations`.
   Production fail closed jika token belum dikonfigurasi. UI admin sekarang
   meminta token dan mengirimnya lewat header `x-admin-token`.

4. RLS dan Data API exposure belum terdokumentasi di schema

   Dampak: perubahan Supabase Data API exposure dan tabel public tanpa RLS bisa
   menjadi risiko saat project dipindah ke environment baru.

   Perbaikan: migration mengaktifkan RLS untuk seluruh tabel public dan revoke
   akses dari `anon`/`authenticated`. Aplikasi tetap memakai server-only
   secret/service key.

5. Konversi satuan belum punya storage resmi

   Dampak: pertanyaan isi kemasan atau konversi unit bisa berulang dijawab
   "belum tercatat", walaupun engine sudah punya interface konversi.

   Perbaikan: schema dan Supabase repository sekarang mendukung
   `unit_conversions`. Seed dummy belum mengisi data konversi agar sistem tidak
   mengarang isi kemasan.

6. Dokumentasi setup tidak sinkron

   Dampak: README menyebut model Gemini lama, migration lama, company id seed,
   dan env debug/admin yang tidak sesuai runtime baru.

   Perbaikan: README dan `.env.example` disesuaikan dengan migration, model,
   `DEFAULT_COMPANY_ID`, `ADMIN_API_TOKEN`, dan policy RLS.

## Verifikasi

Berhasil:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` - 237 test passed
- `pnpm build`
- Supabase changelog dicek untuk perubahan relevan. Catatan penting: tabel baru
  tidak selalu otomatis exposed ke Data API, sehingga migration dibuat dengan
  RLS aktif dan akses browser ditutup.

Belum bisa dijalankan di mesin ini:

- `supabase migration list --local`
- `supabase db lint --local`

Alasan: Supabase local Postgres tidak hidup di `127.0.0.1:54322` dan Docker CLI
tidak tersedia di mesin ini. Verifikasi database perlu dijalankan di mesin yang
punya Docker/Supabase local atau langsung pada project Supabase staging.

## Sisa Risiko Sebelum Dijual

1. Belum ada autentikasi user/admin penuh. Token admin sudah menutup endpoint
   dari akses kosong, tetapi produk komersial sebaiknya memakai auth/session
   admin yang bisa diaudit per orang.

2. Belum ada persistence order final. Sistem masih mengarahkan ke instruksi
   pembayaran/handoff dan tidak menyimpan order resmi.

3. Seed development masih memakai rekening dummy. Production wajib mengganti
   `payment_accounts` dengan rekening resmi sebelum launch.

4. `unit_conversions` belum diisi. Jika sales butuh jawaban "1 dus isi berapa",
   data resmi harus dimasukkan per produk lebih dulu.

5. Migration database belum dibuktikan apply di Supabase local pada mesin ini
   karena Docker tidak tersedia.
