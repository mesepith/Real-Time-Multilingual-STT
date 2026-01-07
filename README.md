# Real-Time Multilingual STT (Deepgram Nova-3)

A fast demo app that streams microphone audio and displays **live speech-to-text** with **multilingual code-switching** (mix multiple languages mid-sentence).

- Frontend: React + Vite (mic UI, live transcript, latency + usage stats)
- Backend: Node.js (WebSocket proxy to Deepgram for speed + reliability + security)
- Deployment: Ubuntu + Apache (reverse proxy for `/api` + `/ws`) + Certbot SSL

---

## Features

- ✅ Click-to-start / click-to-stop microphone
- ✅ Live transcript (interim + final)
- ✅ Multilingual mixed speech (code-switching)
- ✅ Metrics:
  - Deepgram TTFB (ms): Deepgram WS open → first transcript
  - Overall TTFB (ms): first audio sent → first transcript
- ✅ Usage stats:
  - Audio seconds sent
  - Estimated cost (billed by audio time)

---

## Prerequisites

### Local (Mac)
- Node.js (Vite requires Node 20.19+ or 22.12+)
- npm

### Server (Ubuntu)
- Node.js
- pm2 (recommended)
- Apache2
- certbot (Let’s Encrypt)

### Deepgram
- Deepgram API key (store on the server only)

---

## Project Structure

```

.
├── client/                # React + Vite app
└── server/                # Node + Express + WS proxy to Deepgram

````

---

## Environment Variables

### Server: `server/.env`
Create `server/.env`:

```bash
DEEPGRAM_API_KEY=YOUR_DEEPGRAM_API_KEY
PORT=7059

# Optional: pricing estimate (USD per minute for your plan)
DG_PRICE_PER_MIN_MULTI=0.0052
````

---

## Local Development (Mac)

### 1) Start the backend (Node)

```bash
cd server
npm i
npm start
# Runs on http://localhost:7059
# WS on ws://localhost:7059/ws
```

### 2) Start the frontend (Vite)

```bash
cd ../client
npm i
npm run dev -- --port 7058
# Open http://localhost:7058
```

> Tip: Use HTTPS in production for microphone permissions.

---

## Production Build (React)

On your Mac (or on the server):

```bash
cd client
npm i
npm run build
```

This generates:

* `client/dist/index.html`
* `client/dist/assets/*.js` and `*.css`

---

## Deploy to Ubuntu + Apache + Certbot

### 1) Copy frontend build to server

Example:

```bash
scp -r client/dist/* root@YOUR_SERVER:/var/www/html/stt-demo/
```

Confirm on server:

```bash
ls -la /var/www/html/stt-demo
ls -la /var/www/html/stt-demo/assets
```

You must see `index.html` and the hashed assets (JS/CSS).

### 2) Run backend with pm2 (recommended)

Copy `server/` to the server, then:

```bash
cd /root/code-projects/Real-Time-Multilingual-STT/server
npm i
pm2 start index.js --name stt-demo
pm2 save
pm2 startup
```

Check logs:

```bash
pm2 logs stt-demo
```

### 3) Apache vhost (example)

Create:

`/etc/apache2/sites-available/stt-demo.example.com.conf`

```apache
<VirtualHost *:80>
  ServerName stt-demo.example.com
  RewriteEngine On
  RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>

<VirtualHost *:443>
  ServerName stt-demo.example.com
  DocumentRoot /var/www/html/stt-demo

  ErrorLog ${APACHE_LOG_DIR}/stt-demo-error.log
  CustomLog ${APACHE_LOG_DIR}/stt-demo-access.log combined

  <Directory /var/www/html/stt-demo>
    Options -Indexes +FollowSymLinks
    AllowOverride None
    Require all granted

    RewriteEngine On

    # Never rewrite static assets
    RewriteRule ^assets/ - [L]
    RewriteRule ^vite\.svg$ - [L]

    # Never rewrite API / WS
    RewriteRule ^api/ - [L]
    RewriteRule ^ws$ - [L]

    # Serve real files/dirs as-is
    RewriteCond %{REQUEST_FILENAME} -f [OR]
    RewriteCond %{REQUEST_FILENAME} -d
    RewriteRule ^ - [L]

    # SPA fallback
    RewriteRule ^ index.html [L]
  </Directory>

  ProxyPreserveHost On
  RequestHeader set X-Forwarded-Proto "https"

  ProxyPass        /api http://127.0.0.1:7059/api
  ProxyPassReverse /api http://127.0.0.1:7059/api

  ProxyPass        /ws ws://127.0.0.1:7059/ws
  ProxyPassReverse /ws ws://127.0.0.1:7059/ws
  
  ErrorLog ${APACHE_LOG_DIR}/stt-demo-error.log
  CustomLog ${APACHE_LOG_DIR}/stt-demo-access.log combined

SSLCertificateFile /etc/letsencrypt/live/stt-demo.example.com/fullchain.pem
SSLCertificateKeyFile /etc/letsencrypt/live/stt-demo.example.com/privkey.pem
Include /etc/letsencrypt/options-ssl-apache.conf
</VirtualHost>
```

Enable modules + site:

```bash
sudo a2enmod rewrite headers proxy proxy_http proxy_wstunnel ssl
sudo a2ensite stt-demo.example.com.conf
sudo systemctl reload apache2
```

### 4) Certbot SSL

```bash
sudo certbot --apache -d stt-demo.example.com
```

---

## Troubleshooting

### Blank page + console error:

**“Failed to load module script… MIME type text/html”**

This means:

* Browser requested `/assets/*.js`
* Server responded with `index.html` (HTML) instead of JS

Fix checklist:

1. Ensure you deployed the **Vite build output (`dist/`)** to your DocumentRoot:

   ```bash
   ls -la /var/www/html/stt-demo/assets
   ```
2. Ensure Apache rewrite rules **do not rewrite `/assets/`** (see vhost above).
3. Verify the response is JS:

   ```bash
   curl -I https://stt-demo.example.com/assets/<your-file>.js
   ```
4. Hard refresh browser:

   * DevTools → right-click Reload → **Empty Cache and Hard Reload**

### WebSocket not connecting

* Check backend logs:

  ```bash
  pm2 logs stt-demo
  ```
* Ensure Apache has `proxy_wstunnel` enabled:

  ```bash
  sudo a2enmod proxy_wstunnel
  sudo systemctl reload apache2
  ```

---

## Notes

* STT billing is based on **audio duration**, not tokens.
* For fastest + safest setup, the browser streams audio to your Node WS proxy, and the proxy streams to Deepgram using the API key (kept server-side).

---

