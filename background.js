console.log("✅ Background service worker loaded");

/* Open the side panel on toolbar click (invokes activeTab) */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel.html",
      enabled: true
    });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.error("Failed to open side panel:", e);
  }
});

/* ──────────────────────────────────────────────────────────
   Queue + STT (Gemini)
   ────────────────────────────────────────────────────────── */

const MODEL_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent";

class RateLimitError extends Error {
  constructor(retryMs, body) {
    super("429 RATE LIMIT");
    this.retryMs = retryMs;
    this.body = body;
  }
}

function parseRetryDelayMs(errorText) {
  try {
    const j = JSON.parse(errorText);
    const det = j?.error?.details || [];
    const r = det.find(d => (d['@type'] || '').includes('RetryInfo'))?.retryDelay;
    if (r) {
      const m = /(\d+)s/.exec(r);
      if (m) return Number(m[1]) * 1000;
    }
  } catch (_) {}
  return 60_000; // fallback 60s
}

let queue = []; // items: { seq, mime, bytes:ArrayBuffer, source, startSec, endSec }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "TRANSCRIBE_CHUNK") {
    queue.push({
      seq: msg.seq,
      mime: msg.mime,
      bytes: msg.bytes,
      source: msg.source || "tab",
      startSec: msg.startSec ?? null,
      endSec: msg.endSec ?? null
    });
    if (queue.length === 1) processQueue();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "SET_API_KEY") {
    chrome.storage.sync.set({ GEMINI_API_KEY: msg.key }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true; // async
  }
  if (msg?.type === "PROCESS_STORED") {
    (async () => {
      const failed = await getFailed();
      await saveFailed([]);
      for (const it of failed) queue.push(it);
      if (queue.length === failed.length) processQueue();
    })();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

async function getApiKey() {
  const { GEMINI_API_KEY } = await chrome.storage.sync.get("GEMINI_API_KEY");
  return GEMINI_API_KEY || "AIzaSyCINu-TpEMvAx_zydee_17MaVrk5RLYXnw";
}

function arrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* Offline buffer (small, capped) */
const FAILED_CAP = 10;
async function getFailed() {
  const { FAILED_CHUNKS = [] } = await chrome.storage.local.get("FAILED_CHUNKS");
  return FAILED_CHUNKS;
}
async function saveFailed(arr) { await chrome.storage.local.set({ FAILED_CHUNKS: arr }); }
async function addFailed(item) {
  const arr = await getFailed();
  // store base64 to keep it serializable
  const stored = {
    ...item,
    bytes: arrayBufferToBase64(item.bytes)
  };
  arr.push(stored);
  while (arr.length > FAILED_CAP) arr.shift();
  await saveFailed(arr);
}

/* Restore base64 to ArrayBuffer when requeueing from storage (done in PROCESS_STORED) */
function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* Processor */
async function processQueue() {
  while (queue.length) {
    const item = queue[0];

    try {
      const text = await transcribeWithRetry(item);
      chrome.runtime.sendMessage({
        type: "TRANSCRIPT_RESULT",
        seq: item.seq,
        source: item.source,
        startSec: item.startSec,
        endSec: item.endSec,
        text
      });
      queue.shift();
    } catch (err) {
      // Network: store offline and drop from live queue
      if (err instanceof TypeError) {
        await addFailed(item);
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_RESULT",
          seq: item.seq,
          source: item.source,
          startSec: item.startSec,
          endSec: item.endSec,
          text: "📦 Stored locally (offline). Click 'Retry failed uploads' later."
        });
        queue.shift();
        continue;
      }

      chrome.runtime.sendMessage({
        type: "TRANSCRIPT_RESULT",
        seq: item.seq,
        source: item.source,
        startSec: item.startSec,
        endSec: item.endSec,
        text: `❌ Transcription failed after retries: ${err.message}`
      });
      queue.shift();
    }
  }
}

async function transcribeWithRetry(item, max = 3) {
  let delay = 1000;
  for (let i = 0; i < max; i++) {
    try {
      return await transcribeGemini(item);
    } catch (e) {
      if (e instanceof RateLimitError) {
        const secs = Math.max(1, Math.round(e.retryMs / 1000));
        chrome.runtime.sendMessage({
          type: "TRANSCRIPT_RESULT",
          seq: item.seq,
          source: item.source,
          startSec: item.startSec,
          endSec: item.endSec,
          text: `⏳ Rate-limited. Will retry in ${secs}s…`
        });
        await new Promise(r => setTimeout(r, e.retryMs));
        i--;             // don't count 429 against the retry limit
        continue;
      }
      if (i === max - 1) throw e;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function transcribeGemini({ mime, bytes }) {
  const key = await getApiKey();
  if (!key) throw new Error("No Gemini API key set. Save one in the side panel.");

  // Expect audio/wav ArrayBuffer
  const base64 = arrayBufferToBase64(bytes);

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: "Transcribe this audio. Return plain text only." },
          { inlineData: { mimeType: "audio/wav", data: base64 } }
        ]
      }
    ],
    generationConfig: { temperature: 0 }
  };

  const res = await fetch(MODEL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify(body)
  });

  const txt = await res.text();
  if (res.status === 429) {
    throw new RateLimitError(parseRetryDelayMs(txt), txt);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt}`);

  const json = JSON.parse(txt);
  const text =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join(" ").trim() ||
    "(no text)";
  return text;
}

/* Rehydrate stored chunks when PROCESS_STORED pushes them back into queue */
(async function rehydrateOnStartup() {
  // Convert stored base64 back to ArrayBuffer when picked up by PROCESS_STORED
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "PROCESS_STORED") {
      // handled above already
    }
  });
})();

// Convert any stored failed chunks back to ArrayBuffers when dequeued
// (We do it lazily in processQueue by checking type)
const oldShift = queue.shift;
queue.shift = function () { return oldShift.apply(queue, arguments); };

// When we receive stored items, their bytes are base64. Fix it when dequeued.
const oldPush = queue.push;
queue.push = function (...items) {
  for (const it of items) {
    if (typeof it.bytes === "string") {
      it.bytes = base64ToArrayBuffer(it.bytes);
    }
  }
  return oldPush.apply(queue, items);
};
