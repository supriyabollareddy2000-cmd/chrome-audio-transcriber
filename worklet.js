// AudioWorklet: captures raw PCM from the tab/mic stream and posts mono frames.

class PcmCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0];
      if (input && input.length) {
        // Mix to mono
        const chs = input.length;
        const len = input[0].length;
        const mono = new Float32Array(len);
        for (let c = 0; c < chs; c++) {
          const ch = input[c];
          for (let i = 0; i < len; i++) mono[i] += ch[i] / chs;
        }
        // Transfer the underlying ArrayBuffer to main thread
        this.port.postMessage(mono.buffer, [mono.buffer]);
      }
      return true;
    }
  }
  
  registerProcessor("pcm-capture", PcmCaptureProcessor);
  