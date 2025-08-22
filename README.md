# chrome-audio-transcriber
Chrome extension for real-time audio transcription from browser tabs.
# Real-Time Audio Transcriber (Chrome Extension)

Capture audio from a Chrome tab and transcribe in near real time with a clean side panel.

## Features
- Start/Pause/Stop with session timer
- 30/60/90s windows with 3s overlap
- Tab audio capture (+ picker fallback with “Also share tab audio”)
- Optional microphone capture (labeled [mic] vs [tab])
- Retry & 429 rate-limit auto-wait; offline buffering + “Retry failed”
- Export transcript as .txt and structured .json (with timestamps)
- Minimal CPU (AudioWorklet + WAV)

## Install
1. `chrome://extensions` → **Load unpacked** → select this folder.
2. Click the toolbar icon to open the side panel.

## Usage
1. Paste **Gemini API key** from Google AI Studio → **Save Key**.
2. Open a tab that plays audio (YouTube, Meet).
3. Click **Start**. If prompted, pick **Chrome Tab** and enable **“Also share tab audio.”**
4. Transcripts appear every window with timestamps.

## Settings
- **Window length:** 30/60/90 seconds
- **Send every Nth window:** reduce requests to stay within free-tier quota
- **Include microphone:** adds a `[mic]` channel in parallel

## Known Limitations
- Free tier: ~50 requests/day/model — prefer 60–90s windows or sampling.
- DRM/protected tabs may not be capturable.
- No diarization/speaker separation.

## Architecture
Side Panel (UI + AudioWorklet) → PCM → WAV encoder → Background queue (retry/offline) → Gemini generateContent → UI updates.

![architecture](docs/architecture.png)

## Demo
- Video: (link to GitHub release / Drive)
- ZIP package: see Releases

## License
MIT

flowchart TD
  A[Chrome Tab Audio] -->|tabCapture / getDisplayMedia| B[Side Panel<br/>(AudioContext + AudioWorklet)]
  B --> C[Chunker<br/>(30/60/90s) + 3s overlap]
  C --> D[WAV Encoder<br/>(16-bit mono)]
  D --> E[Background Service Worker Queue]
  E -->|fetch| F[Gemini API<br/>generateContent (audio/wav)]
  F --> E
  E --> G[Side Panel UI<br/>(Log + Timestamps + Exports)]
  B --> H[[Mic (optional)]]
  H --> C
  E --> I[Offline Buffer<br/>(chrome.storage.local)]
  E --> J[Retry & Rate-limit<br/>(exponential backoff)]

