import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import "dotenv/config";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const LIPILA_API_URL = (process.env.LIPILA_API_URL || "https://api.lipila.dev").replace(/\/+$/, "");
const LIPILA_API_KEY = process.env.LIPILA_API_KEY;
const LIPILA_WEBHOOK_SECRET = process.env.LIPILA_WEBHOOK_SECRET;
const LIPILA_CURRENCY = process.env.LIPILA_CURRENCY || "ZMW";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const LIPILA_CALLBACK_URL = process.env.LIPILA_CALLBACK_URL;
const LIPILA_TIMEOUT_MS = Number(process.env.LIPILA_TIMEOUT_MS || 30000);

const transactions = new Map();
const processedWebhookIds = new Map();
const idempotencyKeys = new Map();

const ALLOWED_FINAL_STATUSES = new Set(["Successful", "Failed", "Canceled", "Cancelled"]);

function normalizePhone(phone) {
  return String(phone).trim().replace(/[^\d+]/g, "");
}

function maskPhone(phone) {
  const p = normalizePhone(phone);
  if (p.length <= 6) return "***";
  return `${p.slice(0, 4)}${"*".repeat(Math.max(2, p.length - 7))}${p.slice(-3)}`;
}

function isValidPhone(phone) {
  const p = normalizePhone(phone);
  return /^\+?\d{10,15}$/.test(p);
}

function parseAmount(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

function isValidAmount(amount) {
  return Number.isFinite(amount) && amount > 0 && Math.round(amount * 100) === amount * 100;
}

function makeReferenceId() {
  return `WAITAPP-ORD-${crypto.randomUUID()}`;
}

function makeReceiptNumber() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `WAITAPP-ORD-RECEIPT-${stamp}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function providerError(providerStatus, providerBody) {
  const message =
    providerBody?.message ??
    providerBody?.error?.message ??
    providerBody?.error ??
    providerBody?.title ??
    (typeof providerBody === "string" ? providerBody : "Lipila returned an error.");

  return {
    provider: "Lipila",
    httpStatus: providerStatus,
    code: providerBody?.code ?? providerBody?.errorCode ?? undefined,
    message,
    details: providerBody
  };
}

function frontendStatus(lipilaStatus) {
  const s = String(lipilaStatus || "").toLowerCase();
  if (s === "successful" || s === "success" || s === "completed") return "successful";
  if (s === "failed" || s === "failure") return "failed";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "pending";
}

function buildReceipt(tx) {
  return {
    receiptNumber: tx.receiptNumber,
    transactionId: tx.lipilaResponse?.identifier || tx.lipilaResponse?.referenceId || tx.identifier,
    referenceId: tx.lipilaResponse?.referenceId || tx.referenceId,
    identifier: tx.identifier,
    name: tx.name,
    phone: maskPhone(tx.phone),
    amount: tx.amount,
    currency: tx.currency,
    status: tx.status,
    paymentType: tx.lipilaResponse?.paymentType || null,
    message: tx.message || null,
    externalId: tx.lipilaResponse?.externalId || null,
    date: tx.updatedAt || tx.createdAt
  };
}

function publicTransaction(tx) {
  return {
    identifier: tx.identifier,
    referenceId: tx.referenceId,
    lipilaIdentifier: tx.lipilaResponse?.identifier || null,
    status: tx.status,
    phone: maskPhone(tx.phone),
    amount: tx.amount,
    currency: tx.currency,
    message: tx.message || null,
    error: tx.error || null,
    receipt: tx.receipt || null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt
  };
}

function sendTransactionResult(res, tx) {
  const isSuccess = tx.status === "successful";
  const body = {
    success: isSuccess,
    status: tx.status,
    message: tx.message || (tx.status === "pending" ? "Payment request sent to your phone." : null),
    transaction: publicTransaction(tx)
  };

  if (tx.status !== "pending") {
    body.receipt = tx.receipt || buildReceipt(tx);
  }
  if (tx.error) body.error = tx.error;

  return res.status(tx.httpStatus || (tx.status === "pending" ? 200 : 200)).json(body);
}

function cleanOldMaps() {
  const now = Date.now();
  for (const [key, value] of processedWebhookIds) {
    if (now - value > 24 * 60 * 60 * 1000) processedWebhookIds.delete(key);
  }
  for (const [key, value] of idempotencyKeys) {
    if (now - value.createdAt > 24 * 60 * 60 * 1000) idempotencyKeys.delete(key);
  }
}

setInterval(cleanOldMaps, 60 * 60 * 1000).unref();

function corsOptions() {
  if (FRONTEND_URL === "*") return { origin: true, credentials: false };
  const allowed = FRONTEND_URL.split(",").map((x) => x.trim()).filter(Boolean);
  return {
    origin(origin, callback) {
      if (!origin || allowed.includes(origin)) return callback(null, true);
      callback(new Error("CORS origin not allowed"));
    }
  };
}

app.use(cors(corsOptions()));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "lipila-deposit-server",
    environment: LIPILA_API_URL.includes("api.lipila.dev") ? "sandbox" : "production",
    time: new Date().toISOString()
  });
});

// Preserve the exact raw webhook body for Lipila HMAC verification.
app.post(
  "/api/lipila/webhook",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    try {
      if (!LIPILA_WEBHOOK_SECRET) {
        console.error("LIPILA_WEBHOOK_SECRET is not configured.");
        return res.status(500).json({ success: false, error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook verification is not configured." } });
      }

      const webhookId = req.get("webhook-id");
      const webhookTimestamp = req.get("webhook-timestamp");
      const webhookSignature = req.get("webhook-signature");

      if (!webhookId || !webhookTimestamp || !webhookSignature) {
        return res.status(400).json({ success: false, error: { code: "INVALID_WEBHOOK_HEADERS", message: "Required Lipila webhook headers are missing." } });
      }

      const timestamp = Number(webhookTimestamp);
      if (!Number.isFinite(timestamp)) {
        return res.status(400).json({ success: false, error: { code: "INVALID_WEBHOOK_TIMESTAMP", message: "Invalid webhook timestamp." } });
      }

      const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
      if (age > 300) {
        return res.status(400).json({ success: false, error: { code: "STALE_WEBHOOK", message: "Webhook timestamp is outside the 5-minute tolerance." } });
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      const secret = Buffer.from(LIPILA_WEBHOOK_SECRET, "base64");
      const signedPayload = Buffer.concat([
        Buffer.from(`${webhookId}.${webhookTimestamp}.`, "utf8"),
        rawBody
      ]);

      const expected = `v1,${crypto.createHmac("sha256", secret).update(signedPayload).digest("base64")}`;

      const signatures = webhookSignature.split(" ").map((s) => s.trim()).filter(Boolean);
      const expectedBuffer = Buffer.from(expected, "utf8");
      const valid = signatures.some((sig) => {
        const received = Buffer.from(sig, "utf8");
        return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
      });

      if (!valid) {
        return res.status(401).json({ success: false, error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature verification failed." } });
      }

      if (processedWebhookIds.has(webhookId)) {
        return res.status(200).json({ success: true, duplicate: true });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).json({ success: false, error: { code: "INVALID_WEBHOOK_JSON", message: "Webhook body is not valid JSON." } });
      }

      processedWebhookIds.set(webhookId, Date.now());

      const identifier = payload.identifier;
      const referenceId = payload.referenceId;
      let tx = identifier ? transactions.get(identifier) : undefined;

      if (!tx && referenceId) {
        for (const candidate of transactions.values()) {
          if (candidate.referenceId === referenceId) {
            tx = candidate;
            break;
          }
        }
      }

      // A verified webhook can arrive after an in-memory restart.
      // We acknowledge it, but cannot safely associate it with a local transaction.
      if (!tx) {
        console.warn("Verified Lipila webhook received for an unknown transaction:", {
          webhookId,
          identifier,
          referenceId
        });
        return res.status(200).json({ success: true, matched: false });
      }

      const mapped = frontendStatus(payload.status);
      tx.lipilaResponse = { ...(tx.lipilaResponse || {}), ...payload };
      tx.status = mapped;
      tx.message = payload.message || tx.message;
      tx.updatedAt = new Date().toISOString();
      tx.error = mapped === "failed"
        ? {
            provider: "Lipila",
            code: payload.code || payload.errorCode || undefined,
            message: payload.message || "Lipila reported that the transaction failed.",
            details: payload
          }
        : null;

      if (mapped !== "pending") {
        tx.receipt = buildReceipt(tx);
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Webhook processing error:", error.message);
      return res.status(500).json({ success: false, error: { code: "WEBHOOK_PROCESSING_ERROR", message: "Webhook processing failed." } });
    }
  }
);

// JSON parser applies to frontend/API routes after the raw webhook route.
app.use(express.json({ limit: "100kb" }));

app.post("/api/deposit", async (req, res) => {
  try {
    if (!LIPILA_API_KEY) {
      return res.status(500).json({
        success: false,
        status: "failed",
        error: { code: "LIPILA_API_KEY_NOT_CONFIGURED", message: "Lipila API key is not configured on the server." }
      });
    }

    const { name, phone, amount } = req.body || {};
    const customerName = String(name || "").trim();
    const normalizedPhone = normalizePhone(phone);
    const numericAmount = parseAmount(amount);

    if (!customerName || customerName.length > 120) {
      return res.status(400).json({
        success: false,
        status: "failed",
        error: { code: "INVALID_NAME", message: "Name is required and must be 120 characters or fewer." }
      });
    }

    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        status: "failed",
        error: { code: "INVALID_PHONE", message: "Invalid phone number." }
      });
    }

    if (!isValidAmount(numericAmount)) {
      return res.status(400).json({
        success: false,
        status: "failed",
        error: { code: "INVALID_AMOUNT", message: "Amount must be a positive number with at most two decimal places." }
      });
    }

    const idempotencyKey = req.get("Idempotency-Key");
    if (idempotencyKey) {
      const existing = idempotencyKeys.get(idempotencyKey);
      if (existing) {
        const tx = transactions.get(existing.identifier);
        if (tx) return sendTransactionResult(res, tx);
      }
    }

    const identifier = `TXN-${crypto.randomUUID()}`;
    const referenceId = makeReferenceId();
    const now = new Date().toISOString();

    const tx = {
      identifier,
      referenceId,
      name: customerName,
      phone: normalizedPhone,
      amount: numericAmount,
      currency: LIPILA_CURRENCY,
      status: "pending",
      message: "Payment request is being sent to your phone.",
      error: null,
      lipilaResponse: null,
      receiptNumber: makeReceiptNumber(),
      receipt: null,
      createdAt: now,
      updatedAt: now,
      httpStatus: 200
    };

    transactions.set(identifier, tx);
    if (idempotencyKey) idempotencyKeys.set(idempotencyKey, { identifier, createdAt: Date.now() });

    const payload = {
      referenceId,
      amount: numericAmount,
      narration: process.env.LIPILA_NARRATION || `Deposit - ${customerName}`,
      accountNumber: normalizedPhone,
      currency: LIPILA_CURRENCY,
      referenceData: identifier
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIPILA_TIMEOUT_MS);

    const headers = {
      accept: "application/json",
      "x-api-key": LIPILA_API_KEY,
      "Content-Type": "application/json"
    };

    const callbackUrl = LIPILA_CALLBACK_URL || `${getPublicBaseUrl(req)}/api/lipila/webhook`;
    if (callbackUrl) headers.callbackUrl = callbackUrl;

    let response;
    let responseBody;
    try {
      response = await fetch(`${LIPILA_API_URL}/api/v1/collections/mobile-money`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const text = await response.text();
      try {
        responseBody = text ? JSON.parse(text) : {};
      } catch {
        responseBody = text;
      }
    } catch (error) {
      tx.updatedAt = new Date().toISOString();

      if (error.name === "AbortError") {
        tx.message = "Lipila request timed out before the server received a definitive response.";
        tx.error = {
          provider: "Lipila",
          code: "LIPILA_TIMEOUT",
          message: tx.message
        };
      } else {
        tx.message = "The server could not reach Lipila.";
        tx.error = {
          provider: "Lipila",
          code: "LIPILA_CONNECTION_ERROR",
          message: error.message
        };
      }

      tx.status = "failed";
      tx.receipt = buildReceipt(tx);
      return sendTransactionResult(res, tx);
    } finally {
      clearTimeout(timeout);
    }

    tx.lipilaResponse = responseBody;

    if (!response.ok) {
      tx.status = "failed";
      tx.httpStatus = response.status >= 400 && response.status < 600 ? 502 : 500;
      tx.error = providerError(response.status, responseBody);
      tx.message = tx.error.message;
      tx.updatedAt = new Date().toISOString();
      tx.receipt = buildReceipt(tx);
      console.warn("Lipila collection rejected:", {
        identifier,
        referenceId,
        status: response.status,
        message: tx.error.message
      });
      return sendTransactionResult(res, tx);
    }

    const mapped = frontendStatus(responseBody?.status);
    tx.status = mapped === "successful" || mapped === "failed" || mapped === "canceled" ? mapped : "pending";
    tx.message = responseBody?.message || (tx.status === "pending" ? "Payment request sent to your phone." : tx.message);
    tx.updatedAt = new Date().toISOString();

    if (tx.status === "failed") {
      tx.error = {
        provider: "Lipila",
        code: responseBody?.code || responseBody?.errorCode || undefined,
        message: responseBody?.message || "Lipila reported that the collection failed.",
        details: responseBody
      };
      tx.receipt = buildReceipt(tx);
    } else if (tx.status !== "pending") {
      tx.receipt = buildReceipt(tx);
    }

    return sendTransactionResult(res, tx);
  } catch (error) {
    console.error("Deposit error:", error.message);
    return res.status(500).json({
      success: false,
      status: "failed",
      error: { code: "SERVER_ERROR", message: "Unexpected server error." }
    });
  }
});

app.get("/api/deposit/:identifier", async (req, res) => {
  const tx = transactions.get(req.params.identifier);

  if (!tx) {
    return res.status(404).json({
      success: false,
      status: "failed",
      error: { code: "TRANSACTION_NOT_FOUND", message: "Deposit transaction was not found on this server." }
    });
  }

  return sendTransactionResult(res, tx);
});

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const protocol = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  if (!host) return "";
  return `${protocol}://${host}`;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lipila deposit server listening on port ${PORT}`);
  console.log(`Lipila API: ${LIPILA_API_URL}`);
});
