/* eslint-disable no-console */
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
require("dotenv").config();

const PORT = Number(process.env.PORT || 7059);
const DG_KEY = process.env.DEEPGRAM_API_KEY;

if (!DG_KEY) {
  console.error("Missing DEEPGRAM_API_KEY in server/.env");
  process.exit(1);
}

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "demo-stt-server" });
});

/**
 * Pricing: Nova-3 (Multilingual) Pay-As-You-Go shown on Deepgram pricing page. 
 * You can override with env if your plan differs.
 */
const PRICE_PER_MIN_MULTI = Number(process.env.DG_PRICE_PER_MIN_MULTI || 0.0052);

function buildDeepgramUrl({ model, language }) {
  const u = new URL("wss://api.deepgram.com/v1/listen");
  u.searchParams.set("model", model || "nova-3");
  u.searchParams.set("language", language || "multi");

  // Fast, live UX settings
  u.searchParams.set("encoding", "linear16");
  u.searchParams.set("sample_rate", "16000");
  u.searchParams.set("interim_results", "true");
  u.searchParams.set("smart_format", "true");

  // VAD + utterance events
  u.searchParams.set("vad_events", "true");
  u.searchParams.set("endpointing", "100");
  u.searchParams.set("utterance_end_ms", "1000");

  return u.toString();
}

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (clientWs, req) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const model = reqUrl.searchParams.get("model") || "nova-3";
  const language = reqUrl.searchParams.get("language") || "multi";

  const dgUrl = buildDeepgramUrl({ model, language });

  let audioBytes = 0;
  let dgRequestId = null;

  // timing
  const overallStartMs = Date.now();      // client connected to our server
  let dgOpenedMs = null;                 // deepgram ws open time
  let dgFirstResultMs = null;            // deepgram TTFB
  let overallFirstResultMs = null;       // overall TTFB (from first audio -> first transcript)
  let firstAudioSeenMs = null;

  // Open Deepgram WS with server-side Authorization header (fast + secure)
  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DG_KEY}` } // API key auth for WS 
  });

  // Capture request id / failed upgrade details when possible
  dgWs.on("upgrade", (res) => {
    dgRequestId = res.headers["dg-request-id"] || null;
  });

  dgWs.on("unexpected-response", (_request, response) => {
    const dgErr = response.headers["dg-error"];
    const reqId = response.headers["dg-request-id"];
    console.error("Deepgram WS upgrade failed:", {
      statusCode: response.statusCode,
      dgErr,
      reqId
    });

    safeSend(clientWs, {
      type: "proxy_error",
      message: "Deepgram upgrade failed",
      dg_error: dgErr || null,
      dg_request_id: reqId || null
    });

    clientWs.close();
  });

  dgWs.on("open", () => {
    dgOpenedMs = Date.now();
    safeSend(clientWs, {
      type: "dg_open",
      dg_request_id: dgRequestId,
      model,
      language
    });
  });

  dgWs.on("message", (data) => {
    // Deepgram sends text frames (JSON)
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    // Compute TTFB metrics
    if (msg.type === "Results" && dgFirstResultMs == null && dgOpenedMs != null) {
      dgFirstResultMs = Date.now() - dgOpenedMs;
      safeSend(clientWs, { type: "metric", name: "dg_ttfb_ms", value: dgFirstResultMs });
    }
    if (msg.type === "Results" && overallFirstResultMs == null && firstAudioSeenMs != null) {
      overallFirstResultMs = Date.now() - firstAudioSeenMs;
      safeSend(clientWs, { type: "metric", name: "overall_ttfb_ms", value: overallFirstResultMs });
    }

    // Forward Deepgram message to browser
    safeSendRaw(clientWs, msg);
  });

  dgWs.on("close", (code, reason) => {
    safeSend(clientWs, {
      type: "dg_close",
      code,
      reason: reason?.toString?.() || ""
    });
    clientWs.close();
  });

  dgWs.on("error", (err) => {
    console.error("Deepgram WS error:", err?.message || err);
    safeSend(clientWs, { type: "proxy_error", message: "Deepgram WS error" });
    clientWs.close();
  });

  // KeepAlive every 5s (helps long pauses)
  const keepAliveTimer = setInterval(() => {
    if (dgWs.readyState === WebSocket.OPEN) {
      dgWs.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 5000);

  // Send stats every 500ms
  const statsTimer = setInterval(() => {
    const seconds = audioBytes / (2 * 16000);
    const cost = (seconds / 60) * PRICE_PER_MIN_MULTI;
    safeSend(clientWs, {
      type: "stats",
      audio_seconds: Number(seconds.toFixed(2)),
      est_cost_usd: Number(cost.toFixed(6)),
      price_per_min_usd: PRICE_PER_MIN_MULTI,
      dg_request_id: dgRequestId
    });
  }, 500);

  clientWs.on("message", (data, isBinary) => {
    // binary = raw PCM16 frames
    if (isBinary) {
      if (firstAudioSeenMs == null) firstAudioSeenMs = Date.now();
      audioBytes += data.length;

      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(data);
      }
      return;
    }

    // text = control messages
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (msg?.type === "CloseStream") {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: "CloseStream" }));
      }
      return;
    }
  });

  clientWs.on("close", () => {
    clearInterval(keepAliveTimer);
    clearInterval(statsTimer);

    if (dgWs.readyState === WebSocket.OPEN) {
      dgWs.send(JSON.stringify({ type: "CloseStream" }));
      dgWs.close();
    } else {
      try { dgWs.close(); } catch {}
    }

    const totalMs = Date.now() - overallStartMs;
    console.log("Client disconnected. session_ms =", totalMs);
  });

  clientWs.on("error", () => {
    // ignore
  });
});

function safeSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function safeSendRaw(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WS endpoint: ws://localhost:${PORT}/ws`);
});
