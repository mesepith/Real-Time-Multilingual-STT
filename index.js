const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();
app.use(express.json());

// Dev CORS (prod will be same-origin behind Apache)
app.use(
  cors({
    origin: ["http://localhost:7058"],
    methods: ["GET"],
  })
);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Mint a temporary JWT via Deepgram token-based auth
// Docs: POST https://api.deepgram.com/v1/auth/grant with Authorization: Token <API_KEY> :contentReference[oaicite:5]{index=5}
app.get("/api/token", async (_req, res) => {
  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing DEEPGRAM_API_KEY in env" });
    }

    const ttlSeconds = Number(process.env.DEEPGRAM_TOKEN_TTL_SECONDS || 600); // 10 min default (max 3600) :contentReference[oaicite:6]{index=6}

    const t0 = Date.now();
    const dgRes = await axios.post(
      "https://api.deepgram.com/v1/auth/grant",
      { ttl_seconds: ttlSeconds },
      {
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );

    const t1 = Date.now();
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      access_token: dgRes.data.access_token,
      expires_in: dgRes.data.expires_in,
      minted_ms: t1 - t0,
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || { message: err.message };
    return res.status(status).json({ error: "Token mint failed", details: data });
  }
});

const PORT = Number(process.env.PORT || 7059);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
