import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

const app = express();

const LIPILA_API_KEY = "lsk_019d4428-3219-71b5-a42a-82b1b9460eb7";
const LIPILA_BASE_URL = "https://blz.lipila.io/api/v1";

app.use(cors());
app.use(express.json());

function buildReceipt(data, status) {
  return {
    receipt: {
      status: status,
      referenceId: data.referenceId || null,
      identifier: data.identifier || null,
      amount: data.amount || null,
      currency: data.currency || null,
      accountNumber: data.accountNumber || null,
      paymentType: data.paymentType || null,
      message: data.message || null,
      createdAt: data.createdAt || new Date().toISOString(),
    },
    raw: data,
  };
}

async function safeJson(response) {
  const text = await response.text();
  if (!text || text.trim() === "") {
    return { _raw: "", _parseError: "Lipila returned an empty response body." };
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _raw: text, _parseError: `Lipila response could not be parsed as JSON. Raw response: ${text}` };
  }
}

app.post("/initiate", async (req, res) => {
  const { phoneNumber, amount } = req.body;

  if (!phoneNumber || !amount) {
    return res
      .status(400)
      .send("Error: Both phoneNumber and amount are required to initiate a payment.");
  }

  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return res
      .status(400)
      .send("Error: Amount must be a valid positive number.");
  }

  const referenceId = uuidv4().replace(/-/g, "").slice(0, 12);

  const payload = {
    referenceId: referenceId,
    amount: numericAmount,
    narration: "STK Push Payment",
    accountNumber: String(phoneNumber),
    currency: "ZMW",
  };

  let lipilResponse;
  try {
    lipilResponse = await fetch(`${LIPILA_BASE_URL}/collections/mobile-money`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-api-key": LIPILA_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    return res
      .status(502)
      .send(`Error: Could not connect to Lipila API. Check your internet or try again. Detail: ${networkError.message}`);
  }

  const lipilData = await safeJson(lipilResponse);

  if (lipilData._parseError) {
    return res
      .status(502)
      .send(`Error: Lipila API responded with HTTP ${lipilResponse.status} but returned an unreadable body. ${lipilData._parseError}`);
  }

  if (!lipilResponse.ok) {
    const errorMsg =
      lipilData?.message ||
      lipilData?.error ||
      JSON.stringify(lipilData) ||
      "Unknown error from Lipila API";
    return res
      .status(lipilResponse.status)
      .send(`Error ${lipilResponse.status} (${lipilResponse.statusText}): ${errorMsg}`);
  }

  const statusLabel = lipilData.status || "Pending";
  const receipt = buildReceipt({ ...lipilData, referenceId }, statusLabel);

  return res.status(200).json({
    notification: "Payment request sent successfully. Please check your phone for a PIN prompt.",
    referenceId: referenceId,
    ...receipt,
  });
});

app.get("/status", async (req, res) => {
  const { referenceId } = req.query;

  if (!referenceId) {
    return res
      .status(400)
      .send("Error: referenceId query parameter is required.");
  }

  let lipilResponse;
  try {
    lipilResponse = await fetch(
      `${LIPILA_BASE_URL}/collections/check-status?referenceId=${encodeURIComponent(referenceId)}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": LIPILA_API_KEY,
        },
      }
    );
  } catch (networkError) {
    return res
      .status(502)
      .send(`Error: Could not connect to Lipila API. Check your internet or try again. Detail: ${networkError.message}`);
  }

  const lipilData = await safeJson(lipilResponse);

  if (lipilData._parseError) {
    return res
      .status(502)
      .send(`Error: Lipila API responded with HTTP ${lipilResponse.status} but returned an unreadable body. ${lipilData._parseError}`);
  }

  if (!lipilResponse.ok) {
    const errorMsg =
      lipilData?.message ||
      lipilData?.error ||
      JSON.stringify(lipilData) ||
      "Unknown error from Lipila API";
    return res
      .status(lipilResponse.status)
      .send(`Error ${lipilResponse.status} (${lipilResponse.statusText}): ${errorMsg}`);
  }

  const transactionStatus = lipilData.status || "Unknown";
  const receipt = buildReceipt(lipilData, transactionStatus);

  let notification = "";
  if (transactionStatus === "Successful") {
    notification = `Payment Successful! Transaction of ${lipilData.amount} ${lipilData.currency} from ${lipilData.accountNumber} completed via ${lipilData.paymentType}.`;
  } else if (transactionStatus === "Failed") {
    notification = `Payment Failed. Reason: ${lipilData.message || "Unknown reason"}. Payment type: ${lipilData.paymentType || "Unknown"}.`;
  } else if (transactionStatus === "Pending") {
    notification = "Payment is still pending. The user has not yet entered their PIN. If using MTN, try dialing *115#.";
  } else {
    notification = `Transaction status: ${transactionStatus}. Message: ${lipilData.message || "No message provided."}`;
  }

  return res.status(200).json({
    notification,
    ...receipt,
  });
});

app.use((_req, res) => {
  res.status(404).send("Error 404: Route not found on this server.");
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err);
  res.status(500).send(`Error 500: Internal server error. ${err.message}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lipila STK server running on port ${PORT}`);
});
