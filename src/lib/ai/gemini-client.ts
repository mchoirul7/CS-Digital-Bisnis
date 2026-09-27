import { GoogleGenAI } from "@google/genai";
import { getGeminiModel } from "@/lib/config";

type GeminiPart = { text?: string };

type GeminiResponse = {
  text?: string;
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
};

export type GeminiRequest = {
  apiKey: string;
  systemInstruction: string;
  prompt: string;
  temperature: number;
  json?: boolean;
};

function extractText(response: GeminiResponse) {
  if (typeof response.text === "string" && response.text.trim()) {
    return response.text.trim();
  }

  return (response.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join("")
    .trim();
}

/**
 * Pembungkus tipis ke Gemini. Model tidak diberi akses tool bisnis apa pun -
 * ia hanya menerima teks dan mengembalikan teks.
 */
export async function generateGeminiText(request: GeminiRequest): Promise<string> {
  const client = new GoogleGenAI({ apiKey: request.apiKey });
  const generateContent = client.models.generateContent as unknown as (
    input: unknown,
  ) => Promise<GeminiResponse>;

  const response = await generateContent({
    model: getGeminiModel(),
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    config: {
      systemInstruction: request.systemInstruction,
      temperature: request.temperature,
      ...(request.json ? { responseMimeType: "application/json" } : {}),
    },
  });

  return extractText(response);
}

export function parseJsonLoosely(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
