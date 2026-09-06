import { CONFIG } from "./config.ts";

async function telegramCall(method: string, body: Record<string, unknown>) {
  const response = await fetch(
    `https://api.telegram.org/bot${CONFIG.telegramBotToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data.result;
}

export async function sendChatAction(chatId: number, action = "typing") {
  try {
    await telegramCall("sendChatAction", { chat_id: chatId, action });
  } catch (error) {
    console.error("sendChatAction error", error);
  }
}

export function startTypingLoop(chatId: number) {
  void sendChatAction(chatId, "typing");
  const timer = setInterval(() => void sendChatAction(chatId, "typing"), 4000);
  return () => clearInterval(timer);
}

function splitMessage(text: string, maxChars = 3900): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;

  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.6) cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.6) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendMessage(chatId: number, text: string) {
  let lastResult: any = null;
  for (const chunk of splitMessage(text)) {
    lastResult = await telegramCall("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
  return lastResult;
}

export async function getTelegramFile(fileId: string) {
  return await telegramCall("getFile", { file_id: fileId });
}

export async function downloadTelegramVoice(voice: any): Promise<{
  bytes: Uint8Array;
  mimeType: string;
  fileUniqueId: string | null;
  durationSeconds: number | null;
}> {
  if (!voice?.file_id) throw new Error("Telegram voice has no file_id");

  const durationSeconds = Number.isFinite(Number(voice.duration)) ? Number(voice.duration) : null;
  if (durationSeconds && durationSeconds > CONFIG.maxVoiceSeconds) {
    throw new Error(`Voice note is too long for this Edge Function (${durationSeconds}s > ${CONFIG.maxVoiceSeconds}s)`);
  }

  if (voice.file_size && Number(voice.file_size) > 20 * 1024 * 1024) {
    throw new Error("Telegram voice file exceeds 20 MB download limit");
  }

  const file = await getTelegramFile(voice.file_id);
  if (!file?.file_path) throw new Error("Telegram getFile returned no file_path");

  const response = await fetch(
    `https://api.telegram.org/file/bot${CONFIG.telegramBotToken}/${file.file_path}`,
  );
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    mimeType: voice.mime_type || "audio/ogg",
    fileUniqueId: voice.file_unique_id ?? null,
    durationSeconds,
  };
}
