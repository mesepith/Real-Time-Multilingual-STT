/* AudioWorkletProcessor that:
 * - receives Float32 audio (AudioContext sample rate, often 48k)
 * - resamples to 16k
 * - converts to Int16 PCM
 * - posts ArrayBuffer chunks back to main thread
 */
class PCM16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = options?.processorOptions?.targetSampleRate || 16000;
    this.targetSampleRate = target;

    this.inputSampleRate = sampleRate; // AudioContext sample rate
    this.ratio = this.inputSampleRate / this.targetSampleRate;

    this.prev = 0;
    this.pos = 0; // fractional position in "data" buffer
    this.inited = false;
  }

  process(inputs) {
    const input = inputs?.[0]?.[0];
    if (!input || input.length === 0) return true;

    // Initialize prev sample to avoid a pop on first frame
    if (!this.inited) {
      this.prev = input[0];
      this.inited = true;
    }

    // Create a "data" view with prev sample at index 0, then current input
    const dataLen = input.length + 1;

    // How many output samples can we produce safely?
    // We need idx+1 < dataLen
    const maxOut = Math.floor((dataLen - 1 - this.pos) / this.ratio);
    if (maxOut <= 0) {
      // advance pos by input length and carry on
      this.pos = this.pos - input.length;
      this.prev = input[input.length - 1];
      return true;
    }

    const out = new Int16Array(maxOut);

    let pos = this.pos;
    for (let i = 0; i < maxOut; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;

      const s0 = idx === 0 ? this.prev : input[idx - 1];
      const s1 = idx === 0 ? input[0] : input[idx];

      let sample = s0 + (s1 - s0) * frac;

      // float -> int16
      sample = Math.max(-1, Math.min(1, sample));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      pos += this.ratio;
    }

    // Update state for next chunk
    this.pos = pos - input.length; // shift by chunk length
    this.prev = input[input.length - 1];

    // Send PCM16 bytes to main thread (transfer buffer for speed)
    this.port.postMessage(out.buffer, [out.buffer]);

    return true;
  }
}

registerProcessor("pcm16-worklet", PCM16Worklet);
