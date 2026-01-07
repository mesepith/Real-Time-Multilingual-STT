import { useMemo, useRef, useState } from "react";
import "./App.css";

function wsUrl(pathAndQuery) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${pathAndQuery}`;
}

export default function App() {
  const [isOn, setIsOn] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");

  const [dgRequestId, setDgRequestId] = useState(null);
  const [dgTtfb, setDgTtfb] = useState(null);
  const [overallTtfb, setOverallTtfb] = useState(null);

  const [audioSeconds, setAudioSeconds] = useState(0);
  const [estCost, setEstCost] = useState(0);
  const [pricePerMin, setPricePerMin] = useState(0);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const sourceRef = useRef(null);
  const muteGainRef = useRef(null);

  const firstAudioSentAtRef = useRef(null);

  const displayText = useMemo(() => {
    if (!finalText && !interimText) return "…";
    if (!finalText) return interimText;
    if (!interimText) return finalText;
    return `${finalText} ${interimText}`;
  }, [finalText, interimText]);

  async function start() {
    setError("");
    setFinalText("");
    setInterimText("");
    setDgRequestId(null);
    setDgTtfb(null);
    setOverallTtfb(null);
    setAudioSeconds(0);
    setEstCost(0);
    setPricePerMin(0);

    setStatus("connecting");

    // Connect to OUR server WS (same origin). Vite proxies /ws -> 7059 in dev.
    const url = wsUrl("/ws?model=nova-3&language=multi");
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = async () => {
      setStatus("listening");
      setIsOn(true);

      // Start mic + audio pipeline ONLY after ws is open (avoids buffering)
      await startAudio();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      // proxy lifecycle
      if (msg.type === "proxy_error") {
        setError(`${msg.message}${msg.dg_error ? ` | ${msg.dg_error}` : ""}`);
        setStatus("error");
        stop();
        return;
      }

      if (msg.type === "dg_open") {
        setDgRequestId(msg.dg_request_id || null);
        return;
      }

      if (msg.type === "metric") {
        if (msg.name === "dg_ttfb_ms") setDgTtfb(msg.value);
        if (msg.name === "overall_ttfb_ms") setOverallTtfb(msg.value);
        return;
      }

      if (msg.type === "stats") {
        setAudioSeconds(msg.audio_seconds || 0);
        setEstCost(msg.est_cost_usd || 0);
        setPricePerMin(msg.price_per_min_usd || 0);
        if (msg.dg_request_id) setDgRequestId(msg.dg_request_id);
        return;
      }

      // Deepgram streaming messages
      if (msg.type === "Results") {
        const alt = msg?.channel?.alternatives?.[0];
        const t = alt?.transcript || "";
        const isFinal = !!msg.is_final;

        if (!t) return;

        if (isFinal) {
          setFinalText((prev) => (prev ? `${prev} ${t}` : t));
          setInterimText("");
        } else {
          setInterimText(t);
        }
        return;
      }

      if (msg.type === "SpeechStarted") {
        // optional: you can display this state if you want
        return;
      }

      if (msg.type === "UtteranceEnd") {
        // optional: could add a newline or separator
        return;
      }
    };

    ws.onclose = () => {
      if (status !== "error") setStatus("closed");
      setIsOn(false);
    };

    ws.onerror = () => {
      setError("WebSocket error (proxy). Check server logs for dg-error.");
      setStatus("error");
      setIsOn(false);
    };
  }

  async function startAudio() {
    // Get mic
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    streamRef.current = stream;

    // Audio graph
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    await audioCtx.audioWorklet.addModule(
      new URL("./audio/pcm16-worklet.js", import.meta.url)
    );

    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const worklet = new AudioWorkletNode(audioCtx, "pcm16-worklet", {
      processorOptions: { targetSampleRate: 16000 }
    });
    workletRef.current = worklet;

    // Some browsers need the graph connected to destination to process.
    // Connect through a muted gain node.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    muteGainRef.current = mute;

    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(audioCtx.destination);

    worklet.port.onmessage = (e) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const buf = e.data; // ArrayBuffer (PCM16)
      // Backpressure: if network is slow, drop to keep latency low
      if (ws.bufferedAmount > 1_000_000) return;

      if (firstAudioSentAtRef.current == null) firstAudioSentAtRef.current = performance.now();
      ws.send(buf);
    };
  }

  function stop() {
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      }
    } catch {}

    wsRef.current = null;

    try {
      workletRef.current?.disconnect();
    } catch {}
    try {
      sourceRef.current?.disconnect();
    } catch {}
    try {
      muteGainRef.current?.disconnect();
    } catch {}

    workletRef.current = null;
    sourceRef.current = null;
    muteGainRef.current = null;

    try {
      streamRef.current?.getTracks()?.forEach((t) => t.stop());
    } catch {}
    streamRef.current = null;

    try {
      audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;

    firstAudioSentAtRef.current = null;

    setIsOn(false);
    setStatus("idle");
  }

  return (
    <div className="container">
      <div className="header">
        <div>
          <h2 style={{ margin: 0 }}>Demo STT (Nova-3 multilingual)</h2>
          <div className="subhead">
            <span>Status: <b>{status}</b></span>
            <span className="dot">•</span>
            {!isOn ? (
              <span>Click <b>Start</b> and speak (you can mix languages). Click <b>Stop</b> to end.</span>
            ) : (
              <span>Listening… speak now. Click <b>Stop</b> when done.</span>
            )}
          </div>
        </div>

        {!isOn ? (
          <button className="micBtn" onClick={start} title="Start mic">
            <span className="micGlyph">🎤</span>
            <span className="micText">Start</span>
          </button>
        ) : (
          <button className="micBtn listening" onClick={stop} title="Stop mic">
            <span className="micGlyph">⏹</span>
            <span className="micText">Stop</span>
          </button>
        )}
      </div>


      {error ? (
        <div className="card" style={{ borderColor: "#ffcccc", background: "#fff5f5" }}>
          <b>Error:</b>
          <div className="mono" style={{ marginTop: 8 }}>{error}</div>
        </div>
      ) : null}

      <div className="card">
        <div className="cardTitle">Live transcript (interim + final)</div>

        <div className={(!finalText && !interimText) ? "transcriptHint" : "transcriptText"}>
          {(!finalText && !interimText)
            ? "Tip: Click Start and begin speaking. You can switch languages mid-sentence."
            : displayText}
        </div>
      </div>


      <div className="card">
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>Metrics</div>
        <div className="kv">
          <div>Deepgram request id</div>
          <div className="mono">{dgRequestId || "—"}</div>

          <div>Deepgram TTFB (ms)</div>
          <div className="mono">{dgTtfb ?? "—"}</div>

          <div>Overall TTFB (ms)</div>
          <div className="mono">{overallTtfb ?? "—"}</div>

          <div>Audio seconds sent</div>
          <div className="mono">{audioSeconds}</div>

          <div>Estimated cost (USD)</div>
          <div className="mono">
            {estCost} (rate {pricePerMin}/min)
          </div>

          <div>“Tokens”</div>
          <div className="mono">STT is billed by audio time, not tokens. </div>
        </div>
      </div>
    </div>
  );
}
