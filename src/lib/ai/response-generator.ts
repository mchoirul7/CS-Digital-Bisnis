import type {
  BusinessResult,
  DraftReview,
  OperationResult,
  RunningDraft,
  SupplementaryResult,
} from "@/lib/business/types";
import type { ChatHistoryMessage } from "@/lib/chat/types";
import { formatRupiah } from "@/lib/utils/format";
import { generateGeminiText } from "./gemini-client";

export function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function joinList(items: string[]) {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} dan ${items[items.length - 1]}`;
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Menyingkat nama kandidat menjadi pembeda variannya saja ("Indomie Goreng" ->
 * "Goreng") ketika seluruh kandidat memang diawali kata yang customer sebut.
 */
function variantLabels(names: string[], query: string) {
  const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));

  if (queryWords.size === 0) {
    return names;
  }

  const labels = names.map((name) => {
    const words = name.split(/\s+/);
    let start = 0;

    while (start < words.length && queryWords.has(words[start].toLowerCase())) {
      start += 1;
    }

    return words.slice(start).join(" ");
  });

  return labels.every((label) => label.length > 0) ? labels : names;
}

function paymentAccountList(accounts: BusinessResult["payment_accounts"]) {
  return joinList(
    accounts.map(
      (account) => `${account.bank_name} ${account.account_number} a.n. ${account.account_name}`,
    ),
  );
}

function paymentAccountText(accounts: BusinessResult["payment_accounts"]) {
  if (accounts.length === 0) {
    return "Untuk rekening resmi, datanya belum ada di sistem saya, Kak. Biar aman, saya bantu konfirmasi ke admin dulu ya.";
  }

  const list = paymentAccountList(accounts);

  if (accounts.length === 1) {
    return `Untuk pembayaran bisa ke ${list}, Kak. Kami hanya punya 1 rekening resmi, jadi selain itu jangan ditransfer ya.`;
  }

  return `Untuk pembayaran bisa ke rekening resmi kami: ${list}, Kak.`;
}

function productWithPriceText(product: BusinessResult["listed_products"][number]) {
  return `${product.name} ${formatRupiah(product.price)} per ${product.unit}`;
}

/**
 * Kalimat penutup eskalasi. Hanya dipakai kalau handoff-nya memang tersimpan,
 * supaya bot tidak pernah berjanji meneruskan sesuatu yang tidak terjadi.
 */
function escalationSentence(result: BusinessResult) {
  if (!result.handoff.required) {
    return "";
  }

  if (!result.handoff.handoff_id) {
    return " Saya catat dulu ya, Kak, nanti dibantu tim kami.";
  }

  return result.handoff.status === "ACTIVE"
    ? " Percakapannya sudah dipegang admin kami ya, Kak."
    : " Percakapannya saya teruskan ke admin supaya bisa ditindaklanjuti ya, Kak.";
}

function packagingSentence(result: { packaging: BusinessResult["packaging"] }, productName: string) {
  const packaging = result.packaging;

  if (!packaging) {
    return null;
  }

  return `1 ${packaging.outer_unit} ${productName} isinya ${formatQuantity(packaging.quantity_per_outer)} ${packaging.inner_unit}`;
}

function supplementarySentence(item: SupplementaryResult, result: BusinessResult) {
  const productName = result.product?.name ?? "produk itu";

  switch (item.status) {
    case "PACKAGING_INFO_AVAILABLE": {
      const sentence = packagingSentence(item, productName);
      return sentence ? `${sentence}, Kak.` : null;
    }

    case "PACKAGING_DATA_UNAVAILABLE":
      return `Untuk jumlah isi per ${result.product?.unit ?? "kemasan"}-nya belum tercatat di data saya, Kak.`;

    case "RETAIL_AVAILABILITY_UNKNOWN":
      return "Untuk pembelian ecerannya saya belum punya informasi yang pasti, Kak.";

    case "PAYMENT_ACCOUNTS":
      return item.payment_accounts.length > 0
        ? `Untuk pembayarannya ke ${paymentAccountList(item.payment_accounts)}.`
        : null;

    case "DELIVERY_UNAVAILABLE":
      return "Untuk jadwal kirimnya saya belum bisa memastikan.";

    default:
      return null;
  }
}

/**
 * Variasi kalimat "ada lagi?" supaya percakapan tidak terdengar seperti mesin
 * yang mengulang kalimat yang sama setiap kali barang ditambahkan.
 */
const MORE_ITEMS_PROMPTS = [
  "Ada lagi yang mau ditambahkan?",
  "Masih ada yang dibutuhkan?",
  "Ada barang lain sekalian?",
  "Mau sekalian tambah yang lain?",
];

function moreItemsPrompt(result: BusinessResult) {
  const index = Math.max(0, (result.draft_change?.active_item_count ?? 1) - 1);
  return MORE_ITEMS_PROMPTS[index % MORE_ITEMS_PROMPTS.length];
}

/**
 * Daftar barang yang sedang tercatat, tanpa angka uang. Dipakai supaya setiap
 * perubahan tetap terasa sebagai SATU pesanan yang sama, bukan permintaan lepas.
 */
function runningItemsText(draft: RunningDraft) {
  return joinList(
    draft.items.map((item) => `${item.product_name} ${formatQuantity(item.quantity)} ${item.unit}`),
  );
}

const RUNNING_SUMMARY_OPENERS = [
  "Jadi sementara",
  "Untuk sekarang tercatat",
  "Berarti sejauh ini",
  "Sementara yang masuk",
];

function runningSummarySentence(result: BusinessResult) {
  const draft = result.running_draft;

  if (!draft || draft.items.length === 0) {
    return "";
  }

  const opener = RUNNING_SUMMARY_OPENERS[(draft.items.length - 1) % RUNNING_SUMMARY_OPENERS.length];

  if (draft.items.length > 4) {
    return ` ${opener} ada ${draft.items.length} jenis barang: ${runningItemsText(draft)}.`;
  }

  return ` ${opener} ${runningItemsText(draft)}.`;
}

/** Pertanyaan lanjutan untuk operasi yang belum bisa dijalankan. */
function operationIssueSentence(operation: OperationResult) {
  const name = operation.product_name ?? titleCase(operation.requested_query ?? "produk itu");

  switch (operation.status) {
    case "NEEDS_UNIT_CLARIFICATION":
      return `Untuk ${name}, penjualannya tercatat per ${operation.catalog_unit}, bukan ${operation.requested_unit}. Mau ambil berapa ${operation.catalog_unit}?`;
    case "INSUFFICIENT_STOCK":
      return `Untuk ${name} stoknya sekarang tinggal ${formatQuantity(operation.stock_quantity ?? 0)} ${operation.catalog_unit}, jadi ${formatQuantity(operation.requested_quantity ?? 0)} belum bisa terpenuhi.`;
    case "QUANTITY_REQUIRED":
      return `Untuk ${name} mau berapa ${operation.catalog_unit}?`;
    case "INVALID_QUANTITY":
      return `Jumlah untuk ${name} sepertinya belum pas, boleh disebutkan lagi?`;
    case "PRODUCT_AMBIGUOUS":
      return `Untuk ${name} ada beberapa pilihan: ${joinList(operation.candidates)}. Yang mana ya?`;
    case "PRODUCT_NOT_FOUND":
      return operation.candidates.length > 0
        ? `Untuk ${name} belum ada di data produk kami. Yang ada ${joinList(operation.candidates)}.`
        : `Untuk ${name} belum ada di data produk kami.`;
    case "NOT_IN_DRAFT":
      return `${name} belum ada di catatan pesanan ini.`;
    default:
      return "";
  }
}

function operationAnswerSentence(operation: OperationResult) {
  const name = operation.product_name ?? titleCase(operation.requested_query ?? "produk itu");

  if (operation.status !== "APPLIED") {
    return operationIssueSentence(operation);
  }

  switch (operation.reason) {
    case "PRODUCT_FOUND":
      return `${name} ada di data kami.`;

    case "STOCK_AVAILABLE":
      return operation.price !== null
        ? `${name} masih ada, stoknya ${formatQuantity(operation.stock_quantity ?? 0)} ${operation.applied_unit ?? operation.catalog_unit ?? "unit"}. Harganya ${formatRupiah(operation.price)} per ${operation.applied_unit ?? operation.catalog_unit ?? "unit"}.`
        : `${name} masih ada, stoknya ${formatQuantity(operation.stock_quantity ?? 0)} ${operation.applied_unit ?? operation.catalog_unit ?? "unit"}.`;

    case "OUT_OF_STOCK":
      return operation.price !== null
        ? `${name} stoknya lagi kosong. Harga terdaftarnya ${formatRupiah(operation.price)} per ${operation.applied_unit ?? operation.catalog_unit ?? "unit"}.`
        : `${name} stoknya lagi kosong.`;

    case "PRICE_AVAILABLE":
      return `Harga ${name} ${formatRupiah(operation.price ?? 0)} per ${operation.applied_unit ?? operation.catalog_unit ?? "unit"}.`;

    case "QUOTE_CREATED": {
      const quantity = `${formatQuantity(operation.requested_quantity ?? operation.applied_quantity ?? 0)} ${operation.requested_unit ?? operation.applied_unit ?? operation.catalog_unit ?? "unit"}`;
      const stockNote =
        operation.stock_sufficient === false
          ? ` Stok tersedia ${formatQuantity(operation.stock_quantity ?? 0)} ${operation.catalog_unit ?? operation.applied_unit ?? "unit"}.`
          : "";

      return `Untuk ${quantity} ${name} totalnya ${formatRupiah(operation.total ?? 0)}.${stockNote}`;
    }

    default:
      return "";
  }
}

function draftSummary(draft: DraftReview) {
  return draft.items
    .map((item) => {
      const line = `${item.product_name} ${formatQuantity(item.quantity)} ${item.unit}`;
      return item.subtotal === null ? line : `${line} ${formatRupiah(item.subtotal)}`;
    })
    .join(", ");
}

function checkoutItemLine(item: DraftReview["items"][number]) {
  const unitPrice = item.unit_price === null ? "-" : formatRupiah(item.unit_price);
  const subtotal = item.subtotal === null ? "-" : formatRupiah(item.subtotal);

  return `${item.product_name} — ${formatQuantity(item.quantity)} ${item.unit} × ${unitPrice} = ${subtotal}`;
}

function paymentAccountBlock(account: BusinessResult["payment_accounts"][number]) {
  return [
    "Pembayaran ke:",
    account.bank_name,
    account.account_number,
    `a.n. ${account.account_name}`,
  ].join("\n");
}

function renderCheckoutInstructions(result: BusinessResult) {
  const draft = result.draft;
  const account = result.payment_accounts[0];

  if (!draft || draft.items.length === 0) {
    return "Belum ada barang yang tercatat, Kak.";
  }

  if (!account) {
    return "Untuk rekening resminya saya bantu konfirmasikan ke admin dulu ya.";
  }

  if (draft.items.length === 1) {
    const item = draft.items[0];
    return `Siap, Kak. ${checkoutItemLine(item)}. Total: ${formatRupiah(draft.grand_total ?? 0)}. Pembayaran ke ${account.bank_name} ${account.account_number} a.n. ${account.account_name}. Setelah transfer, kirim bukti pembayarannya di sini ya, Kak.`;
  }

  const lines = draft.items.map((item) => `• ${checkoutItemLine(item)}`).join("\n");

  return [
    "Siap, Kak. Berikut pesanannya:",
    "",
    lines,
    "",
    `*Total: ${formatRupiah(draft.grand_total ?? 0)}*`,
    "",
    paymentAccountBlock(account),
    "",
    "Setelah transfer, kirim bukti pembayarannya di sini ya, Kak.",
  ].join("\n");
}

export type ResponseRenderOptions = {
  /** Produk berasal dari konteks, bukan disebut ulang customer di pesan ini. */
  isFollowUp?: boolean;
};

/**
 * Template deterministik. Dipakai sebagai jawaban dasar tanpa Gemini dan sebagai
 * fallback ketika business guard memblokir jawaban model.
 * Semua angka di sini berasal dari BusinessResult.
 */
export function renderDeterministicResponse(
  result: BusinessResult,
  options: ResponseRenderOptions = {},
): string {
  const productName = result.product?.name ?? "produk itu";
  const stockUnit = result.availability?.unit ?? result.product?.unit ?? "unit";
  const requestedQuantity = result.requested.quantity;
  const urgencyPrefix = result.urgency ? "Wah, kebutuhannya cukup mendesak ya, Kak. " : "";
  const escalation = escalationSentence(result);

  const main = (() => {
    switch (result.status) {
      case "GREETING_RESPONSE":
        return "Halo, Kak. Saya bisa bantu cek produk, stok, harga, total pesanan, rekening resmi, atau info pengiriman yang tersedia.";

      case "THANKS_RESPONSE":
        return "Sama-sama, Kak. Kalau nanti perlu cek stok atau harga lagi, tinggal kabari ya.";

      case "PRODUCT_LISTED": {
        if (result.listed_products.length === 0) {
          return "Saat ini saya belum menemukan produk aktif yang bisa ditampilkan, Kak. Biar aman, saya bantu konfirmasikan ke admin dulu ya.";
        }

        const products = joinList(result.listed_products.map(productWithPriceText));
        const more = result.pagination?.has_more
          ? " Masih ada produk lain juga, jadi Kakak boleh sebutkan nama produk yang mau dicek."
          : "";

        return `Kami ada beberapa pilihan, Kak. Saat ini ada ${products}.${more || " Mau saya bantu cek stoknya?"}`;
      }

      case "STOCK_AVAILABLE":
        if (result.price === null) {
          return options.isFollowUp
            ? `Masih ada, Kak. Sisanya ${formatQuantity(result.availability?.quantity ?? 0)} ${stockUnit}.`
            : `Masih ada, Kak. Stok ${productName} saat ini ${formatQuantity(result.availability?.quantity ?? 0)} ${stockUnit}.`;
        }

        return options.isFollowUp
          ? `Masih ada, Kak. Sisanya ${formatQuantity(result.availability?.quantity ?? 0)} ${stockUnit}. Harganya ${formatRupiah(result.price)} per ${result.product?.unit ?? stockUnit}.`
          : `Masih ada, Kak. Stok ${productName} saat ini ${formatQuantity(result.availability?.quantity ?? 0)} ${stockUnit}. Harganya ${formatRupiah(result.price)} per ${result.product?.unit ?? stockUnit}.`;

      case "OUT_OF_STOCK":
        return result.price !== null
          ? `Untuk ${productName} stoknya lagi kosong, Kak. Harga terdaftarnya ${formatRupiah(result.price)} per ${result.product?.unit ?? stockUnit}. Kalau mau, saya bantu tanyakan ke admin kapan masuk lagi.`
          : `Untuk ${productName} stoknya lagi kosong, Kak. Kalau mau, saya bantu tanyakan ke admin kapan masuk lagi.`;

      case "PRICE_AVAILABLE":
        return options.isFollowUp
          ? `${formatRupiah(result.price ?? 0)} per ${result.product?.unit ?? stockUnit}, Kak.`
          : `Harga ${productName} ${formatRupiah(result.price ?? 0)} per ${result.product?.unit ?? stockUnit}, Kak.`;

      case "PRODUCT_FOUND":
        return `${productName} ada di data kami, Kak. Mau saya cekkan stok atau harganya?`;

      case "PACKAGING_INFO_AVAILABLE": {
        const sentence = packagingSentence(result, productName);
        return sentence ? `${sentence}, Kak.` : `Isi kemasannya belum tercatat di data saya, Kak.`;
      }

      case "PACKAGING_DATA_UNAVAILABLE":
        return `Untuk jumlah isi per ${result.product?.unit ?? "kemasan"}-nya belum tercatat di data saya, Kak. Yang pasti tercatat baru harga dan stok per ${result.product?.unit ?? stockUnit}.`;

      case "RETAIL_AVAILABILITY_UNKNOWN":
        return `Untuk pembelian ecerannya saya belum punya informasi yang pasti, Kak. Di data saya ${productName} tercatat per ${result.product?.unit ?? stockUnit}.`;

      case "QUOTE_CREATED": {
        const quantityText = `${formatQuantity(requestedQuantity ?? 0)} ${result.requested.unit ?? stockUnit}`;
        const base = options.isFollowUp
          ? `Kalau ${quantityText} totalnya ${formatRupiah(result.total ?? 0)}`
          : `Untuk ${quantityText} ${productName} totalnya ${formatRupiah(result.total ?? 0)}`;

        if (result.stock_sufficient) {
          return `${base}, Kak. Stoknya masih aman.`;
        }

        return `${urgencyPrefix}${base}, Kak. Cuma stok yang tersedia sekarang ${formatQuantity(result.availability?.quantity ?? 0)} ${stockUnit}, jadi untuk ${quantityText} belum bisa terpenuhi semuanya.`;
      }

      // Barang baru masuk daftar: catat, tunjukkan seluruh pesanan berjalan,
      // dan jangan buru-buru menutup transaksi dengan total.
      case "READY_FOR_CONFIRMATION":
        return `Siap, ${productName} ${formatQuantity(requestedQuantity ?? 0)} ${result.requested.unit ?? stockUnit} saya catat.${runningSummarySentence(result)} ${moreItemsPrompt(result)}`;

      case "ITEM_UPDATED":
        return `Oke, ${productName} saya ubah jadi ${formatQuantity(requestedQuantity ?? 0)} ${result.requested.unit ?? stockUnit}.${runningSummarySentence(result)} ${moreItemsPrompt(result)}`;

      case "ITEM_RESTORED":
        return `Oke, ${productName} saya aktifkan lagi${
          requestedQuantity === null ? "" : ` ${formatQuantity(requestedQuantity)} ${result.requested.unit ?? stockUnit}`
        }, Kak.${runningSummarySentence(result)} ${moreItemsPrompt(result)}`;

      case "ITEM_REMOVED":
        return `Oke, ${productName} saya batalkan ya, Kak.${
          runningSummarySentence(result) || " Yang lain tetap seperti tadi."
        }`;

      case "DRAFT_UPDATED":
        return `Siap, Kak.${runningSummarySentence(result)} ${moreItemsPrompt(result)}`;

      case "DRAFT_PARTIALLY_UPDATED": {
        const issues = result.operation_results
          .filter((operation) => operation.status !== "APPLIED")
          .map(operationIssueSentence)
          .filter(Boolean);

        return `Siap, Kak.${runningSummarySentence(result)} ${issues.join(" ")}`.trim();
      }

      case "MULTI_PRODUCT_RESULT": {
        const sentences = result.operation_results
          .map(operationAnswerSentence)
          .filter(Boolean);

        return sentences.length > 0
          ? sentences.join(" ")
          : "Boleh sebutkan lagi produk yang mau dicek, Kak?";
      }

      case "PAYMENT_INSTRUCTIONS": {
        return renderCheckoutInstructions(result);
      }

      case "PAYMENT_PROOF_REQUESTED":
        return "Siap, Kak. Kalau sudah transfer, tolong kirim bukti transfernya di sini ya supaya bisa dicek.";

      case "PAYMENT_PROOF_MISSING":
        return "Siap, Kak. Bukti transfernya belum terkirim nih. Silakan lampirkan filenya di sini, nanti saya bantu teruskan untuk pengecekan.";

      case "PAYMENT_PROOF_RECEIVED":
        return "Bukti transfernya sudah saya terima, Kak. Saya teruskan ke admin untuk dicek ya, nanti dikabari lagi.";

      case "DRAFT_CLEARED":
        return "Oke, semua yang tadi saya batalkan, Kak. Kalau mau mulai lagi tinggal sebutkan barangnya.";

      case "DRAFT_EMPTY":
        return "Belum ada barang yang tercatat, Kak. Mau mulai dari produk yang mana?";

      case "DRAFT_ITEM_UNRESOLVED":
        return `Boleh dipastikan dulu, Kak, barang yang mana yang dimaksud? Saya belum menemukannya di catatan pesanan ini.`;

      case "ORDER_REVIEWED": {
        const draft = result.draft;
        if (!draft || draft.items.length === 0) {
          return "Belum ada barang yang tercatat, Kak.";
        }

        return `${draft.items.map((item) => `${item.product_name}: ${formatQuantity(item.quantity)} ${item.unit} x ${formatRupiah(item.unit_price ?? 0)} = ${formatRupiah(item.subtotal ?? 0)}`).join("\n")}\n\nTotal ${formatRupiah(draft.grand_total ?? 0)}. Konfirmasi pesanan ini, Kak?`;
      }

      case "ORDER_PERSISTED":
        return `Pesanan ${result.persisted_order?.order_number} sudah tersimpan, Kak.\n${result.draft ? draftSummary(result.draft) : ""}\nTotal ${formatRupiah(result.total ?? 0)}. ${result.persisted_order?.status === "completed" ? "Pesanan sudah selesai." : "Admin akan memproses pesanan ini."}`;

      case "ORDER_CANCELLED":
        return `Pesanan ${result.persisted_order?.order_number} dibatalkan, Kak.\n${result.draft ? draftSummary(result.draft) : ""}\nStok yang dipesan sudah dilepas.`;

      case "ORDER_CONFIRMATION_FAILED":
        if (result.reason === "QUOTE_CHANGED") return "Harga atau satuan berubah sejak ringkasan tadi, Kak. Minta ringkasan baru dulu sebelum konfirmasi lagi ya.";
        if (result.reason === "INSUFFICIENT_STOCK") return "Stok tersedia berubah dan belum mencukupi pesanan ini, Kak. Pesanan belum tersimpan; silakan periksa ringkasan lagi.";
        if (result.reason === "INVALID_ORDER_TRANSITION") return "Status pesanan ini sudah tidak memungkinkan pembatalan, Kak. Saya bisa bantu hubungkan ke admin.";
        return "Pesanan belum bisa dikonfirmasi, Kak. Periksa ringkasan dan konfirmasi kembali ya.";

      case "ORDER_REVIEW_NEEDS_ADJUSTMENT": {
        const draft = result.draft;
        if (!draft || draft.items.length === 0) {
          return "Belum ada barang yang tercatat, Kak.";
        }

        const problems = draft.items.filter((item) => item.issue !== "NONE");
        const fine = draft.items.filter((item) => item.issue === "NONE");
        const problemText = problems
          .map((item) =>
            item.issue === "INSUFFICIENT_STOCK"
              ? `${item.product_name} diminta ${formatQuantity(item.quantity)} ${item.unit} tapi stoknya sekarang ${formatQuantity(item.stock_quantity ?? 0)} ${item.inventory_unit}`
              : `${item.product_name} belum bisa saya pastikan`,
          )
          .join("; ");

        const fineText =
          fine.length > 0 ? `${draftSummary({ ...draft, items: fine })} masih aman. ` : "";

        return `${fineText}Cuma ${problemText}, Kak. Mau jumlahnya disesuaikan?`;
      }

      case "PAYMENT_VERIFICATION_REQUIRED":
        return "Siap, Kak. Untuk memastikan pembayarannya benar-benar sudah masuk, saya bantu cekkan ke tim kami dulu ya.";

      case "INSUFFICIENT_STOCK": {
        const available = formatQuantity(result.availability?.quantity ?? 0);
        return `${urgencyPrefix}Untuk ${formatQuantity(requestedQuantity ?? 0)} ${result.requested.unit ?? stockUnit} belum bisa terpenuhi semua, Kak. Stok ${productName} yang tersedia sekarang ${available} ${stockUnit}. Kalau mau, ${available} ${stockUnit} dulu yang kita lanjutkan, atau kekurangannya saya bantu konfirmasikan ke admin.`;
      }

      case "NEEDS_CLARIFICATION": {
        const requestedUnit = result.unit_resolution?.requested_unit ?? "satuan itu";
        const inventoryUnit = result.unit_resolution?.inventory_unit ?? stockUnit;
        const quantityText = requestedQuantity === null ? "" : `${formatQuantity(requestedQuantity)} `;
        return `Biar jumlahnya nggak keliru, ${productName} di data kami tercatat per ${inventoryUnit}, Kak, sedangkan tadi Kakak menyebut ${quantityText}${requestedUnit}. Maksudnya ${quantityText}${requestedUnit} atau ${quantityText}${inventoryUnit}?`;
      }

      case "INVALID_QUANTITY":
        return `Sepertinya jumlahnya belum pas, Kak. Boleh sebutkan lagi mau berapa ${result.product?.unit ?? stockUnit} ${productName}?`;

      case "QUANTITY_REQUIRED":
        return `Siap, Kak. Untuk ${productName} mau berapa ${result.product?.unit ?? stockUnit}?`;

      case "PRODUCT_AMBIGUOUS": {
        const names = result.candidates.map((product) => product.name);
        const labels = variantLabels(names, result.requested.product_query ?? "");
        const prefix =
          labels === names
            ? "Ada beberapa produk yang cocok"
            : `Ada beberapa pilihan ${titleCase(result.requested.product_query ?? "")}`;
        return `${prefix}, Kak: ${joinList(labels)}. Yang mau dicek yang mana?`;
      }

      case "PRODUCT_NOT_FOUND": {
        const query = result.requested.product_query?.trim();

        if (!query) {
          return "Boleh sebutkan produknya, Kak? Nanti saya bantu cek stok atau harganya.";
        }

        if (result.suggestions.length === 0) {
          return `Untuk ${titleCase(query)} belum ada di data produk kami, Kak. Boleh sebutkan nama produk lain yang mau dicek?`;
        }

        return `Untuk ${titleCase(query)} saya belum menemukannya, Kak. Yang ada ${joinList(result.suggestions.map((product) => product.name))}. Kalau itu yang dicari, saya bisa bantu cek stoknya.`;
      }

      case "PAYMENT_ACCOUNTS":
        return paymentAccountText(result.payment_accounts);

      case "DELIVERY_UNAVAILABLE":
        return "Untuk pengiriman dan cara ambil barangnya saya belum bisa memastikan, Kak. Biar nggak salah janji, saya cek dulu ke tim kami ya.";

      case "DISCOUNT_NOT_AVAILABLE":
        return requestedQuantity !== null
          ? "Untuk jumlah segitu memang lebih pas dicek harga khususnya, Kak. Cuma soal diskon saya belum punya aturannya, jadi belum bisa saya janjikan sendiri."
          : "Untuk diskon saya belum punya aturannya, Kak, jadi belum bisa saya janjikan sendiri.";

      case "COMPLAINT_ESCALATED":
        return "Waduh, saya bantu cekkan ya, Kak. Untuk kondisi seperti ini perlu dicek langsung oleh tim kami.";

      case "HANDOFF_CREATED":
        return "Siap, Kak.";

      case "DATA_UNAVAILABLE":
        return "Sebentar ya, Kak. Datanya belum berhasil saya cek saat ini. Daripada saya kasih angka yang belum pasti, lebih aman dicek dulu oleh tim kami.";

      case "NO_BUSINESS_REQUEST":
      default:
        return "Siap, Kak. Saya bisa bantu cek stok, harga, total pesanan, atau rekening pembayaran. Mau mulai dari yang mana?";
    }
  })();

  const extras = result.supplementary
    .map((item) => supplementarySentence(item, result))
    .filter((sentence): sentence is string => Boolean(sentence));

  return [main, ...extras].join(" ") + escalation;
}

const SYSTEM_INSTRUCTION = `
Kamu adalah customer service distributor yang ramah dan cekatan, membalas dalam
bahasa Indonesia yang natural dan hangat, seperti CS manusia yang sedang
melanjutkan obrolan - bukan sistem yang membacakan data.

ATURAN MUTLAK:
- Pakai HANYA fakta dari business_result. Jangan menambah, mengubah, membulatkan,
  atau menghitung ulang angka apa pun.
- Jangan mengubah nama produk, satuan, jumlah stok, harga, total, rekening, atau
  status pesanan.
- Nama bank, nomor rekening, dan nama pemilik rekening hanya boleh diambil dari
  payment_accounts di business_result.
- Kalau order_allowed bernilai false, jangan menyatakan pesanan diterima, siap
  diproses, atau stok mencukupi.
- Jangan pernah mengatakan pesanan sudah dibuat atau tercatat; sistem baru sampai
  tahap konfirmasi.
- Kalau handoff.required bernilai false, JANGAN menjanjikan meneruskan ke admin.
  Kalau true, sampaikan dengan wajar bahwa percakapan diteruskan ke admin.
- Jangan menyebut istilah internal (status, kode, nama tool, database, AI, skor).
- Jangan menyebut angka yang tidak ada di business_result.
- Jangan memastikan layanan yang datanya tidak ada (COD, ambil sendiri, jadwal
  kirim). Menyatakan "bisa" maupun "tidak bisa" sama-sama mengarang; katakan
  saja belum bisa dipastikan dan perlu dicek.
- Untuk status PAYMENT_INSTRUCTIONS, produk, jumlah, satuan, harga satuan,
  subtotal, total, dan rekening wajib persis dari business_result.draft dan
  payment_accounts. Jangan menghitung subtotal atau total sendiri.
- Jika PAYMENT_INSTRUCTIONS berisi lebih dari 1 item aktif, format sebagai list
  WhatsApp: satu item per baris dengan format "• Product Name — Qty Unit × Unit
  Price = Subtotal", lalu baris kosong, "*Total: Rp...*", lalu rekening, lalu
  instruksi kirim bukti transfer. Jangan gabungkan beberapa produk dalam satu
  paragraf.
- Jika PAYMENT_INSTRUCTIONS berisi 1 item aktif, pakai satu paragraf compact.
- Jangan menambah turn konfirmasi pembayaran lagi setelah rekening diberikan;
  langsung minta customer kirim bukti transfer.

GAYA:
- 1-3 kalimat, ringkas, mudah dibaca.
- Ini SATU percakapan yang mengalir. Kalau produknya sudah dibahas di pesan
  sebelumnya, jawab langsung ke intinya tanpa mengulang nama produk dan tanpa
  pembuka formal.
- Hindari kalimat kaku yang berulang seperti "Yang tercatat di data kami",
  "Produk tidak ditemukan", "Saya dapat membantu".
- Ramah, boleh menyapa "Kak" seperlunya, jangan berlebihan.
- Empati secukupnya dan sesuai konteks, jangan minta maaf berkali-kali.
- Sesuaikan sedikit dengan gaya customer (santai atau formal), tetap sopan.
- Jangan memakai emoji berlebihan dan jangan memakai bullet list.
`.trim();

function buildPrompt(input: {
  message: string;
  history: ChatHistoryMessage[];
  result: BusinessResult;
  fallback: string;
  isFollowUp: boolean;
}) {
  const recent = input.history
    .slice(-6)
    .map((item) => `${item.role === "user" ? "Customer" : "CS"}: ${item.content}`)
    .join("\n");

  const facts = {
    status: input.result.status,
    product: input.result.product ? { name: input.result.product.name, unit: input.result.product.unit } : null,
    product_already_in_conversation: input.isFollowUp,
    requested: input.result.requested,
    availability: input.result.availability,
    price: input.result.price,
    total: input.result.total,
    maximum_available: input.result.maximum_available,
    shortfall: input.result.shortfall,
    stock_sufficient: input.result.stock_sufficient,
    unit_match: input.result.unit_match,
    order_allowed: input.result.order_allowed,
    packaging: input.result.packaging,
    draft: input.result.draft
      ? {
          items: input.result.draft.items.map((item) => ({
            product_name: item.product_name,
            quantity: item.quantity,
            unit: item.unit,
            inventory_unit: item.inventory_unit,
            unit_price: item.unit_price,
            subtotal: item.subtotal,
            stock_quantity: item.stock_quantity,
            stock_sufficient: item.stock_sufficient,
            issue: item.issue,
          })),
          cancelled_items: input.result.draft.cancelled_items.map((item) => item.product_name),
          grand_total: input.result.draft.grand_total,
          all_available: input.result.draft.all_available,
        }
      : null,
    supplementary: input.result.supplementary.map((item) => ({
      intent: item.intent,
      status: item.status,
      packaging: item.packaging,
      payment_accounts: item.payment_accounts,
    })),
    handoff: { required: input.result.handoff.required, saved: Boolean(input.result.handoff.handoff_id) },
    operation_results: input.result.operation_results.map((operation) => ({
      action: operation.action,
      status: operation.status,
      reason: operation.reason,
      requested_query: operation.requested_query,
      requested_quantity: operation.requested_quantity,
      requested_unit: operation.requested_unit,
      product_name: operation.product_name,
      applied_quantity: operation.applied_quantity,
      applied_unit: operation.applied_unit,
      catalog_unit: operation.catalog_unit,
      stock_quantity: operation.stock_quantity,
      price: operation.price,
      total: operation.total,
      stock_sufficient: operation.stock_sufficient,
      candidates: operation.candidates,
    })),
    candidates: input.result.candidates.map((product) => product.name),
    suggestions: input.result.suggestions.map((product) => product.name),
    listed_products: input.result.listed_products.map((product) => ({
      name: product.name,
      unit: product.unit,
      price: product.price,
    })),
    pagination: input.result.pagination,
    payment_accounts: input.result.payment_accounts,
    customer_urgency: input.result.urgency,
  };

  return [
    recent ? `Riwayat percakapan:\n${recent}` : "Riwayat percakapan: (kosong)",
    `Pesan customer terbaru: ${input.message}`,
    `business_result:\n${JSON.stringify(facts, null, 2)}`,
    `Jawaban cadangan yang faktanya sudah benar (boleh kamu buat lebih natural dan lebih ringkas, jangan ubah angkanya):\n${input.fallback}`,
    "Tulis satu balasan untuk customer sekarang.",
  ].join("\n\n");
}

export type ResponseGenerationResult = {
  candidate: string;
  source: "gemini" | "deterministic" | "deterministic-after-gemini-error";
  fallback: string;
  error?: string;
};

/**
 * Menyusun bahasa jawaban setelah fakta final. Model bahasa tidak pernah dipanggil
 * sebelum business engine selesai, sehingga ia tidak bisa ikut memutuskan fakta.
 */
export async function generateResponse(input: {
  message: string;
  history: ChatHistoryMessage[];
  result: BusinessResult;
  isFollowUp?: boolean;
  apiKey?: string;
}): Promise<ResponseGenerationResult> {
  const isFollowUp = input.isFollowUp ?? false;
  const fallback = renderDeterministicResponse(input.result, { isFollowUp });

  if (!input.apiKey || input.result.persisted_order || input.result.status === "ORDER_REVIEWED" || input.result.status === "ORDER_CONFIRMATION_FAILED") {
    return { candidate: fallback, source: "deterministic", fallback };
  }

  try {
    const text = await generateGeminiText({
      apiKey: input.apiKey,
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPrompt({ ...input, fallback, isFollowUp }),
      temperature: 0.6,
    });

    if (!text) {
      return {
        candidate: fallback,
        source: "deterministic-after-gemini-error",
        fallback,
        error: "Gemini tidak mengembalikan teks.",
      };
    }

    return { candidate: text, source: "gemini", fallback };
  } catch (error) {
    return {
      candidate: fallback,
      source: "deterministic-after-gemini-error",
      fallback,
      error: error instanceof Error ? error.message : "Gemini response generation gagal",
    };
  }
}
