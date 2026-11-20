# M-Pesa Daraja setup

The sponsor form posts to the Node.js endpoint `/donate`, which sends the
request to Safaricom Daraja. Daraja credentials are read only from the server
process environment; never put them in browser JavaScript, Git, or chat.

## Requirements and local setup

Install Node.js and npm. From the `backend` folder, install the backend
dependencies:

```powershell
npm install
```

Run the backend in its own PowerShell terminal:

```powershell
Set-Location .\backend
$env:PORT = "3000"
$env:HOST = "127.0.0.1"
$env:FRONTEND_ORIGINS = "http://127.0.0.1:5500,http://localhost:5500"
$env:MPESA_ENVIRONMENT = "sandbox"
$env:MPESA_CONSUMER_KEY = "<your-sandbox-consumer-key>"
$env:MPESA_CONSUMER_SECRET = "<your-sandbox-consumer-secret>"
$env:MPESA_SHORTCODE = "174379"
$env:MPESA_PASSKEY = "<your-sandbox-passkey>"
$env:MPESA_CALLBACK_URL = "https://<your-public-https-host>/mpesa-callback"
npm start
```

Serve `frontend/index.html` independently with VS Code Live Server or another
static web server. For Live Server, use `http://127.0.0.1:5500` (or
`http://localhost:5500`). The frontend API base URL is set in
`frontend/api-config.js` as `window.API_BASE_URL`, defaulting to
`http://127.0.0.1:3000`. To use a different backend URL, update that variable
and set the backend's `FRONTEND_ORIGINS` to the frontend's exact origin. The
backend health check is available at `http://127.0.0.1:3000/health`.

## Required Daraja configuration

| Environment variable     | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `MPESA_ENVIRONMENT`      | `sandbox` (default) or `production`                                                  |
| `MPESA_CONSUMER_KEY`     | Daraja consumer key                                                                  |
| `MPESA_CONSUMER_SECRET`  | Daraja consumer secret                                                               |
| `MPESA_SHORTCODE`        | Paybill or Buy Goods shortcode                                                       |
| `MPESA_PASSKEY`          | Passkey for that shortcode                                                           |
| `MPESA_CALLBACK_URL`     | Public HTTPS URL ending in `/mpesa-callback`                                         |
| `MPESA_TRANSACTION_TYPE` | Optional; `CustomerPayBillOnline` by default, or `CustomerBuyGoodsOnline` for a Till |
| `FRONTEND_ORIGINS`       | Comma-separated frontend origins allowed by the backend's CORS policy                |

The callback must be reachable by Safaricom over HTTPS. For local testing, use
a trusted HTTPS tunnel to the Node.js server and set the public URL ending in
`/mpesa-callback` as `MPESA_CALLBACK_URL`. Do not put real credentials in
HTML, browser JavaScript, or the repository.

Keep `MPESA_ENVIRONMENT` set to `sandbox` while testing. Only set it to
`production` after configuring the live credentials, shortcode, passkey,
transaction type, and callback URL from the approved Daraja production app.
The server accepts amounts from KES 1 through KES 150,000 and Kenyan mobile
numbers in `07...`, `01...`, or `254...` format.

## Local JSON storage

The server creates `backend/data/records.json` on startup. It stores mentor
application details, donation requests and their statuses, and received
M-Pesa callback details. Uploaded profile images are stored separately under
`~/ImaraBoysFoundry/uploads`; each JSON mentor record contains the generated
image filename.

The JSON file is server-side only and is excluded from Git because it contains
personal and payment-related information. Back it up securely. This simple
file store is intended for a single local server process, not concurrent
multi-instance or production deployments.

The frontend's Submissions page displays mentor contact details, profile
photos, and donation amounts and phone numbers. It has no sign-in protection.
The server binds to `127.0.0.1` by default, so keep it on a trusted machine;
do not expose it on a network or deploy it publicly without adding access
controls and obtaining the submitters' consent.

## Payment status limitations

The callback endpoint stores callback details and correlates them with a
donation when possible, but callbacks are not cryptographically verified.
Records explicitly remain unverified; do not treat an STK Push response or
callback as proof that funds were received. Reconcile payments through Daraja
until verified payment processing is implemented.
