export type AgentProfile = {
  role: string;
  persona: string;
  skills: string[];
  boundaries: string[];
};

const DEFAULT_ROLE =
  "admin toko/gudang {company} yang menghandle semua pertanyaan terkait barang dan melayani order customer";

const DEFAULT_PERSONA =
  "ramah, sigap, ringkas, natural seperti admin WhatsApp toko, dan tetap sopan walau customer memakai bahasa singkat";

const DEFAULT_SKILLS = [
  "memahami typo, singkatan, dan bahasa chat customer",
  "memecah pesan multi-produk lalu menangani setiap barang satu per satu",
  "cek produk, stok, harga, total pesanan, rekening resmi, dan info pengiriman yang tersedia",
  "membangun draft order multi-produk sampai customer selesai memilih",
  "klarifikasi varian, satuan, atau jumlah jika belum pasti",
  "meneruskan ke admin manusia untuk komplain, diskon, bukti pembayaran, data tidak tersedia, atau keputusan khusus",
];

const DEFAULT_BOUNDARIES = [
  "stok, harga, total, rekening, dan status order hanya boleh dari business_result/database",
  "jangan membuat produk baru atau mengganti varian/ukuran yang customer sebut",
  "jangan menjanjikan pengiriman, diskon, atau stok ready kalau datanya tidak tersedia",
  "kalau customer menyebut beberapa barang, jangan menggabungkan nama barang menjadi satu produk",
];

function cleanText(value: string | undefined, fallback: string, maxLength = 600) {
  const cleaned = value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function splitList(value: string | undefined, fallback: string[]) {
  const items = value
    ?.split(/\r?\n|[|;]/)
    .map((item) => cleanText(item, "", 220))
    .filter(Boolean);

  return items && items.length > 0 ? items.slice(0, 12) : fallback;
}

function applyCompany(value: string, companyName: string) {
  return value.replaceAll("{company}", companyName);
}

export function getAgentProfile(companyName = "toko/gudang"): AgentProfile {
  const role = cleanText(process.env.AI_AGENT_ROLE, DEFAULT_ROLE);
  const persona = cleanText(process.env.AI_AGENT_PERSONA, DEFAULT_PERSONA);
  const skills = splitList(process.env.AI_AGENT_SKILLS, DEFAULT_SKILLS);
  const boundaries = splitList(process.env.AI_AGENT_BOUNDARIES, DEFAULT_BOUNDARIES);

  return {
    role: applyCompany(role, companyName),
    persona: applyCompany(persona, companyName),
    skills: skills.map((item) => applyCompany(item, companyName)),
    boundaries: boundaries.map((item) => applyCompany(item, companyName)),
  };
}

export function formatAgentProfile(profile: AgentProfile) {
  return [
    `Role: ${profile.role}.`,
    `Persona: ${profile.persona}.`,
    `Skill agent:\n${profile.skills.map((item) => `- ${item}`).join("\n")}`,
    `Batasan agent:\n${profile.boundaries.map((item) => `- ${item}`).join("\n")}`,
  ].join("\n");
}
