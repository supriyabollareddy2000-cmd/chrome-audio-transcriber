/* ===================== State ===================== */
let stream = null;            // tab/picker stream
let ac = null;                // AudioContext
let source = null;            // MediaStreamAudioSourceNode
let node = null;              // AudioWorkletNode
let muteGain = null;          // prevent echo

// Optional microphone path
let micStream=null, micAc=null, micSource=null, micNode=null, micGain=null;
let micBody=[], micBodySamples=0, micOverlap=[], micOverlapSamples=0, micSeq=0;

let paused = false;
let timerId = null, t0 = null;

let WINDOW_SEC = 30;          // configurable via UI
const OVERLAP_SEC  = 3;       // fixed 3s overlap
let SEND_EVERY_N = 1;         // sampling to save quota

// Sample rate set when AudioContext starts
let sr = 48000;

// PCM buffers for TAB path
let bodyChunks = [];          // Float32Array[] (body ~WINDOW_SEC)
let bodySamples = 0;
let overlapChunks = [];       // Float32Array[] (last ~3s)
let overlapSamples = 0;
let seq = 0;

// Structured transcript for JSON export
const transcriptLog = [];     // {seq, startSec, endSec, source, text}

/* ===================== Helpers ===================== */
const $ = (id)=>document.getElementById(id);
const log = (t)=>{ $("log").textContent += t + "\n"; $("log").scrollTop = $("log").scrollHeight; };
const setBtns = (s)=>{ $("startBtn").disabled=!s.start; $("pauseBtn").disabled=!s.pause; $("stopBtn").disabled=!s.stop; };
const setStatus = (t)=> $("status").textContent = t;
function fmtClock(s) { const m=Math.floor(s/60), ss=Math.floor(s%60); return `${m.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`; }

/* ===================== WAV helpers ===================== */
function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let x = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
  }
}
function encodeWav(monoFloat32, sampleRate) {
  const buffer = new ArrayBuffer(44 + monoFloat32.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + monoFloat32.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, monoFloat32.length * 2, true);

  floatTo16BitPCM(view, 44, monoFloat32);
  return buffer; // ArrayBuffer
}
function concatFloat32(chunks) {
  const total = chunks.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of chunks) { out.set(a, off); off += a.length; }
  return out;
}
function trimQueueToLimit(queue, countInQueue, limit) {
  // Trim from front so sum(lengths) <= limit
  let toTrim = countInQueue - limit;
  while (toTrim > 0 && queue.length) {
    const first = queue[0];
    if (first.length <= toTrim) {
      queue.shift();
      toTrim -= first.length;
      countInQueue -= first.length;
    } else {
      // slice off the front portion
      queue[0] = first.subarray(first.length - (first.length - toTrim));
      countInQueue -= toTrim;
      toTrim = 0;
    }
  }
  return countInQueue;
}

/* ===================== API KEY UI ===================== */
async function loadSavedKeyIntoUI() {
  try {
    const { GEMINI_API_KEY } = await chrome.storage.sync.get("GEMINI_API_KEY");
    if (GEMINI_API_KEY) {
      $("apiKeyInput").value = GEMINI_API_KEY;
      $("keyStatus").textContent = "Key loaded";
    } else {
      $("keyStatus").textContent = "No key saved";
    }
  } catch (e) {
    log("⚠️ Failed to read key: " + e.message);
    $("keyStatus").textContent = "Read error";
  }
}
async function saveKey() {
  const key = ($("apiKeyInput").value || "").trim();
  if (!key) { $("keyStatus").textContent = "Empty"; log("❌ Paste your Gemini API key."); return; }
  try {
    await chrome.storage.sync.set({ GEMINI_API_KEY: key });
    $("keyStatus").textContent = "Saved ✓";
    log("🔑 API key saved");
  } catch (err) {
    log("⚠️ storage.set failed (" + err.message + "), trying via background…");
    try {
      const resp = await chrome.runtime.sendMessage({ type: "SET_API_KEY", key });
      if (resp?.ok) { $("keyStatus").textContent = "Saved ✓ (via BG)"; log("🔑 API key saved via background"); }
      else throw new Error(resp?.error || "unknown");
    } catch (err2) {
      $("keyStatus").textContent = "Save failed";
      log("❌ Could not save key: " + err2.message);
    }
  }
}
$("saveKeyBtn")?.addEventListener("click", saveKey);
$("showKeyChk")?.addEventListener("change", (e)=>{ $("apiKeyInput").type = e.target.checked ? "text" : "password"; });
loadSavedKeyIntoUI();

/* ===================== Export & retry buttons ===================== */
$("copyBtn").onclick = ()=>navigator.clipboard.writeText($("log").textContent);
$("downloadTxtBtn").onclick = ()=>{
  const blob = new Blob([$("log").textContent], {type:"text/plain"});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: "transcript.txt" });
  a.click(); URL.revokeObjectURL(url);
};
$("downloadJsonBtn").onclick = ()=>{
  const blob = new Blob([JSON.stringify(transcriptLog, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: "transcript.json" });
  a.click(); URL.revokeObjectURL(url);
};
$("retryBtn").onclick = ()=> chrome.runtime.sendMessage({ type: "PROCESS_STORED" });

/* ===================== UI controls ===================== */
$("windowSel").addEventListener("change", e => { WINDOW_SEC = Number(e.target.value); });
$("sendEverySel").addEventListener("change", e => { SEND_EVERY_N = Number(e.target.value); });
$("startBtn").onclick = startCapture;
$("pickTabBtn").onclick = ()=>{ setBtns({start:false, pause:false, stop:false}); fallbackGetDisplayMedia(); $("tabLabel").textContent = "• (picker)"; };
$("pauseBtn").onclick = togglePause;
$("stopBtn").onclick  = stopCapture;
setBtns({start:true, pause:false, stop:false});
setStatus("Idle");

document.addEventListener("keydown", (e)=>{ if (e.key === " ") { e.preventDefault(); $("pauseBtn").click(); } });

/* ===================== Timer ===================== */
function startTimer(){
  t0 = Date.now();
  timerId = setInterval(()=>{
    const s = Math.floor((Date.now()-t0)/1000);
    $("timer").textContent = `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
  },1000);
}
function stopTimer(){ clearInterval(timerId); $("timer").textContent = "00:00"; }

async function showCurrentTabLabel(label="(current tab)") {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    $("tabLabel").textContent = `• ${t?.title || label}`;
  } catch { $("tabLabel").textContent = `• ${label}`; }
}

/* ===================== Capture Flow (TAB) ===================== */
function startCapture(){
  setBtns({start:false, pause:false, stop:false});
  setStatus("Requesting tab audio…");

  chrome.tabCapture.capture({ audio:true, video:false }, (s) => {
    if (chrome.runtime.lastError || !s) {
      const msg = chrome.runtime.lastError?.message || "unknown";
      log("❌ tabCapture failed: " + msg);

      if (/activeTab permission/i.test(msg) || /Chrome pages cannot be captured/i.test(msg)) {
        log("🪄 Falling back to picker. Select this tab and enable 'Also share tab audio'.");
        fallbackGetDisplayMedia();
        return;
      }
      setStatus("Error"); setBtns({start:true, pause:false, stop:false});
      return;
    }
    beginWorkletRecording(s, false);
  });
}

async function fallbackGetDisplayMedia(){
  try {
    const ds = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
    const aud = ds.getAudioTracks();
    if (!aud.length) {
      log("❌ Picker returned no audio. Choose 'Chrome Tab' and enable 'Also share tab audio'.");
      ds.getTracks().forEach(t=>t.stop());
      setStatus("Error"); setBtns({start:true, pause:false, stop:false});
      return;
    }
    ds.getVideoTracks().forEach(t => t.stop());
    const audioOnly = new MediaStream(aud);
    beginWorkletRecording(audioOnly, true);
  } catch (e) {
    log("❌ Picker canceled/failed: " + e.message);
    setStatus("Error"); setBtns({start:true, pause:false, stop:false});
  }
}

async function beginWorkletRecording(s, fromPicker){
  stream = s;

  // Reset buffers
  bodyChunks = []; bodySamples = 0; overlapChunks = []; overlapSamples = 0; seq = 0;

  setStatus("Recording…");
  log(fromPicker ? "🎤 Recording (picker fallback)" : "🎤 Recording (tabCapture)");
  setBtns({start:false, pause:true, stop:true});
  startTimer();
  showCurrentTabLabel();

  ac = new (window.AudioContext || window.webkitAudioContext)();
  await ac.audioWorklet.addModule(chrome.runtime.getURL("worklet.js"));
  sr = ac.sampleRate;

  source = ac.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ac, "pcm-capture");
  muteGain = ac.createGain(); muteGain.gain.value = 0;

  source.connect(node);
  node.connect(muteGain).connect(ac.destination);

  node.port.onmessage = (ev) => {
    const chunk = new Float32Array(ev.data);
    bodyChunks.push(chunk);
    bodySamples += chunk.length;

    overlapChunks.push(chunk);
    overlapSamples += chunk.length;
    const overlapLimit = OVERLAP_SEC * sr;
    if (overlapSamples > overlapLimit) {
      overlapSamples = trimQueueToLimit(overlapChunks, overlapSamples, overlapLimit);
    }

    const bodyLimit = WINDOW_SEC * sr;
    if (bodySamples >= bodyLimit) {
      const windowPCM = concatFloat32([...overlapChunks, ...bodyChunks]);
      const wavAB = encodeWav(windowPCM, sr);
      const id = ++seq;

      // start/end (wall clock since capture start)
      const startSec = (id - 1) * WINDOW_SEC;
      const endSec = startSec + OVERLAP_SEC + WINDOW_SEC;

      if (id % SEND_EVERY_N !== 0) {
        log(`⏭ Skipped sending window #${id} (sampling)`);
      } else {
        chrome.runtime.sendMessage({
          type: "TRANSCRIBE_CHUNK",
          seq: id,
          mime: "audio/wav",
          bytes: wavAB,
          source: "tab",
          startSec,
          endSec
        });
        log(`📤 Sent window #${id} for transcription (${(windowPCM.length/sr).toFixed(1)}s)`);
      }

      bodyChunks = [];
      bodySamples = 0;
    }
  };
}

/* ===================== Pause/Stop ===================== */
function togglePause(){
  if (!ac) return;
  if (!paused) {
    ac.suspend();
    paused = true;
    $("pauseBtn").textContent = "Resume";
    setStatus("Paused"); log("⏸ Paused");
  } else {
    ac.resume();
    paused = false;
    $("pauseBtn").textContent = "Pause";
    setStatus("Recording…"); log("▶️ Resumed");
  }
}

function stopCapture(){
  try { node?.port?.close?.(); } catch(_) {}
  try { source?.disconnect?.(); } catch(_) {}
  try { node?.disconnect?.(); } catch(_) {}
  try { muteGain?.disconnect?.(); } catch(_) {}
  try { ac?.close?.(); } catch(_) {}
  ac = null; node = null; source = null; muteGain = null;

  stream?.getTracks().forEach(t => t.stop());
  stream = null;

  // stop mic if active
  if (micAc || micStream) stopMicChain();

  log("🛑 Recording stopped");
  setStatus("Idle"); stopTimer();
  setBtns({start:true, pause:false, stop:false});
  paused = false;
  $("pauseBtn").textContent = "Pause";
}

/* ===================== Microphone (optional) ===================== */
$("micToggle").addEventListener("change", async (e)=>{
  if (!e.target.checked) { stopMicChain(); log("🎙️ Mic disabled"); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    micAc = new (window.AudioContext||window.webkitAudioContext)();
    await micAc.audioWorklet.addModule(chrome.runtime.getURL("worklet.js"));
    micSource = micAc.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micAc, "pcm-capture");
    micGain = micAc.createGain(); micGain.gain.value = 0;
    micSource.connect(micNode); micNode.connect(micGain).connect(micAc.destination);

    micBody=[]; micOverlap=[]; micBodySamples=0; micOverlapSamples=0; micSeq=0;

    micNode.port.onmessage = (ev)=>{
      const chunk = new Float32Array(ev.data);
      micBody.push(chunk); micBodySamples += chunk.length;

      micOverlap.push(chunk); micOverlapSamples += chunk.length;
      const overlapLimit = OVERLAP_SEC * micAc.sampleRate;
      if (micOverlapSamples > overlapLimit) {
        micOverlapSamples = trimQueueToLimit(micOverlap, micOverlapSamples, overlapLimit);
      }
      const bodyLimit = WINDOW_SEC * micAc.sampleRate;
      if (micBodySamples >= bodyLimit) {
        const windowPCM = concatFloat32([...micOverlap, ...micBody]);
        const wavAB = encodeWav(windowPCM, micAc.sampleRate);
        const id = ++micSeq;
        const startSec = (id - 1) * WINDOW_SEC;
        const endSec = startSec + OVERLAP_SEC + WINDOW_SEC;

        if (id % SEND_EVERY_N !== 0) {
          log(`⏭ Skipped MIC window #${id} (sampling)`);
        } else {
          chrome.runtime.sendMessage({ type:"TRANSCRIBE_CHUNK", seq:id, mime:"audio/wav", bytes:wavAB, source:"mic", startSec, endSec });
          log(`🎙️📤 Sent MIC window #${id} (${(windowPCM.length/micAc.sampleRate).toFixed(1)}s)`);
        }

        micBody = []; micBodySamples = 0;
      }
    };
    log("🎙️ Mic enabled");
  } catch (err) {
    log("❌ Could not enable microphone: " + err.message);
    $("micToggle").checked = false;
  }
});
function stopMicChain() {
  try { micNode?.port?.close?.(); } catch(_) {}
  try { micSource?.disconnect?.(); } catch(_) {}
  try { micNode?.disconnect?.(); } catch(_) {}
  try { micGain?.disconnect?.(); } catch(_) {}
  try { micAc?.close?.(); } catch(_) {}
  micAc = null; micNode = null; micSource = null; micGain = null;
  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;
}

/* ===================== Receive transcripts ===================== */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TRANSCRIPT_RESULT") {
    const src = msg.source ? `[${msg.source}] ` : "";
    if (typeof msg.text === "string" && (msg.text.startsWith("⏳") || msg.text.startsWith("📦") || msg.text.startsWith("❌"))) {
      // status line (no timestamp)
      log(`${src}${msg.text}`);
      return;
    }
    const start = typeof msg.startSec === "number" ? msg.startSec : (msg.seq - 1) * WINDOW_SEC;
    const end   = typeof msg.endSec   === "number" ? msg.endSec   : (start + OVERLAP_SEC + WINDOW_SEC);
    const stamp = `[${fmtClock(start)}–${fmtClock(end)}]`;
    log(`📝 Transcript #${msg.seq} ${src}${stamp}:\n${msg.text}\n`);
    transcriptLog.push({ seq: msg.seq, startSec: start, endSec: end, source: msg.source || "tab", text: msg.text });
  }
});
