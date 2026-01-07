import { useMemo, useRef, useState } from "react";
import "./App.css";

const DG_SAMPLE_RATE = 16000;

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return buffer;
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }

    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPCM(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("idle");
  const [finalLines, setFinalLines] = useState([]);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");

  const [dgRequestId, setDgRequestId] = useState("");
  const [dgCreated, setDgCreated] = useState("");
  const [dgDuration, setDgDuration] = useState(null);
  const [detectedLanguages, setDetectedLanguages] = useState([]);

  const [tokenMintMs, setTokenMintMs] = useState(null);
  const [timeToFirstTextMs, setTimeToFirstTextMs] = useState(null);
  const [lastDgLatencyMs, setLastDgLatencyMs] = useState(null);

  const pricePerMin = Number(import.meta.env.VITE_DG_USD_PER_MIN || 0);

  // refs for audio/ws
  const wsRef = useRef(null);
  const keepAliveRef = useRef(null);

  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);

  const startedClickPerfRef = useRef(null);
  const audioStartPerfRef = useRef(null);
  const sentSamplesRef = useRef(0);
  const gotFirstTextRef = useRef(false);

  const estAudioSeconds = useMemo(
    () => sentSamplesRef.current / DG_SAMPLE_RATE,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isRecording, finalLines.length, interim]
  );

  const estCostUsd = useMemo(() => {
    if (!pricePerMin) return 0;
    return (estAudioSeconds / 60) * pricePerMin;
  }, [estAudioSeconds, pricePerMin]);

  async function start() {
    setError("");
    setFinalLines([]);
    setInterim("");
    setStatus("starting...");
    setDgRequestId("");
    setDgCreated("");
    setDgDuration(null);
    setDetectedLanguages([]);
    setTokenMintMs(null);
    setTimeToFirstTextMs(null);
    setLastDgLatencyMs(null);

    sentSamplesRef.current = 0;
    gotFirstTextRef.current = false;
    audioStartPerfRef.current = null;
    startedClickPerfRef.current = performance.now();

    try {
      // Run mic permission + token mint in parallel for speed
      const micPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const tokenPromise = fetch("/api/token").then(async (r) => {
        if (!r.ok) throw new Error(`Token endpoint failed: ${r.status}`);
        return r.json();
      });

      const [stream, tokenResp] = await Promise.all([micPromise, tokenPromise]);

      streamRef.current = stream;
      setTokenMintMs(tokenResp.minted_ms ?? null);

      const accessToken = tokenResp.access_token;
      if (!accessToken) throw new Error("No access_token returned from backend");

      // Deepgram Live Audio WebSocket.
      // We use nova-3 + language=multi (codeswitching) + endpointing=100 per docs. :contentReference[oaicite:9]{index=9}
      // Token can be provided via `token` query param, e.g. `bearer <token>`. :contentReference[oaicite:10]{index=10}
      const qs = new URLSearchParams({
        model: "nova-3",
        language: "multi",
        encoding: "linear16",
        sample_rate: String(DG_SAMPLE_RATE),
        interim_results: "true",
        endpointing: "100",
        smart_format: "true",
        vad_events: "true",
        utterance_end_ms: "1000",
        token: `bearer ${accessToken}`,
      });

      const wsUrl = `wss://api.deepgram.com/v1/listen?${qs.toString()}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setStatus("connected");
        setIsRecording(true);

        // KeepAlive to keep the stream open during silence
        keepAliveRef.current = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "KeepAlive" }));
            }
          } catch {}
        }, 10_000);

        // Start audio pipeline
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioContextCtor({ latencyHint: "interactive" });
        audioCtxRef.current = audioCtx;

        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;

        // ScriptProcessor is widely supported; buffer size tuned for low latency.
        const processor = audioCtx.createScriptProcessor(2048, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;

          if (audioStartPerfRef.current === null) {
            audioStartPerfRef.current = performance.now();
          }

          const input = e.inputBuffer.getChannelData(0);
          const downsampled = downsampleBuffer(input, audioCtx.sampleRate, DG_SAMPLE_RATE);
          const pcm16 = floatTo16BitPCM(downsampled);

          sentSamplesRef.current += pcm16.length;
          ws.send(pcm16.buffer);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination); // required in some browsers
      };

      ws.onmessage = (evt) => {
        const now = performance.now();
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }

        if (msg.type === "Metadata") {
          setDgRequestId(msg.request_id || "");
          setDgCreated(msg.created || "");
          setDgDuration(typeof msg.duration === "number" ? msg.duration : null);
          return;
        }

        if (msg.type === "Results") {
          const alt = msg.channel?.alternatives?.[0];
          const t = alt?.transcript ?? "";
          const langs = alt?.languages ?? [];
          if (langs.length) setDetectedLanguages(langs);

          if (t) {
            // time to first text (overall)
            if (!gotFirstTextRef.current) {
              gotFirstTextRef.current = true;
              const t0 = startedClickPerfRef.current ?? now;
              setTimeToFirstTextMs(Math.round(now - t0));
            }

            // “Deepgram generation time” proxy: end-of-audio -> receive time.
            // Use word timestamps (or msg.start + msg.duration) and our local audio-start perf time.
            const audioStart = audioStartPerfRef.current;
            if (audioStart != null) {
              let audioEndSec = null;

              const words = alt?.words ?? [];
              if (words.length) {
                audioEndSec = words[words.length - 1]?.end ?? null;
              } else if (typeof msg.start === "number" && typeof msg.duration === "number") {
                audioEndSec = msg.start + msg.duration;
              }

              if (typeof audioEndSec === "number") {
                const expectedEndPerf = audioStart + audioEndSec * 1000;
                setLastDgLatencyMs(Math.round(now - expectedEndPerf));
              }
            }
          }

          if (msg.is_final) {
            if (t) setFinalLines((prev) => [...prev, t]);
            setInterim("");
          } else {
            setInterim(t);
          }
        }
      };

      ws.onerror = () => setStatus("ws error");
      ws.onclose = () => {
        setStatus("closed");
        setIsRecording(false);
      };
    } catch (e) {
      setError(String(e?.message || e));
      setStatus("idle");
      stop(true);
    }
  }

  function stop(silent = false) {
    try {
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;

      const ws = wsRef.current;
      wsRef.current = null;

      // Ask Deepgram to flush any buffered results
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "Finalize" }));
          ws.send(JSON.stringify({ type: "CloseStream" }));
        } catch {}
        try {
          ws.close();
        } catch {}
      }

      // Stop audio
      const processor = processorRef.current;
      const source = sourceRef.current;
      if (processor) {
        try {
          processor.disconnect();
          processor.onaudioprocess = null;
        } catch {}
      }
      if (source) {
        try {
          source.disconnect();
        } catch {}
      }
      processorRef.current = null;
      sourceRef.current = null;

      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      if (ctx) {
        try {
          ctx.close();
        } catch {}
      }

      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    } finally {
      if (!silent) {
        setIsRecording(false);
        setStatus("idle");
      }
    }
  }

  const displayed = useMemo(() => {
    const lines = [...finalLines];
    if (interim) lines.push(interim);
    return lines;
  }, [finalLines, interim]);

  return (
    <div className="page">
      <h1>Demo STT (Deepgram Nova-3 Multilingual)</h1>

      <div className="controls">
        <button
          className={`mic ${isRecording ? "recording" : ""}`}
          onClick={() => (isRecording ? stop() : start())}
        >
          <span className="micIcon" />
          {isRecording ? "Stop" : "Start"}
        </button>

        <div className="status">
          <div><b>Status:</b> {status}</div>
          {error ? <div className="err"><b>Error:</b> {error}</div> : null}
        </div>
      </div>

      <div className="transcript">
        <div className="transcriptTitle">Live transcript</div>
        <div className="transcriptBody">
          {displayed.length ? (
            displayed.map((l, i) => (
              <div key={i} className={i === displayed.length - 1 && interim ? "interim" : ""}>
                {l}
              </div>
            ))
          ) : (
            <div className="hint">Press Start and speak (you can mix languages).</div>
          )}
        </div>
      </div>

      <div className="metrics">
        <div className="metric"><b>Token mint (backend):</b> {tokenMintMs ?? "—"} ms</div>
        <div className="metric"><b>Time to first text (overall):</b> {timeToFirstTextMs ?? "—"} ms</div>
        <div className="metric"><b>Last “Deepgram latency” (audio-end → text):</b> {lastDgLatencyMs ?? "—"} ms</div>

        <div className="metric"><b>Request ID:</b> {dgRequestId || "—"}</div>
        <div className="metric"><b>Deepgram created:</b> {dgCreated || "—"}</div>
        <div className="metric"><b>Deepgram duration (from Metadata):</b> {dgDuration ?? "—"} s</div>
        <div className="metric"><b>Detected languages:</b> {detectedLanguages.length ? detectedLanguages.join(", ") : "—"}</div>

        <div className="metric"><b>Estimated audio sent:</b> {estAudioSeconds.toFixed(2)} s</div>
        <div className="metric">
          <b>Estimated cost:</b>{" "}
          {pricePerMin ? `$${estCostUsd.toFixed(6)} (at $${pricePerMin}/min)` : "Set VITE_DG_USD_PER_MIN to estimate"}
        </div>
      </div>

      <div className="footerNote">
        Using: <code>model=nova-3</code>, <code>language=multi</code>, <code>endpointing=100</code>, <code>interim_results=true</code>.
      </div>
    </div>
  );
}
