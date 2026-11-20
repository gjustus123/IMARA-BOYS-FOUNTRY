"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { JsonFileStore } = require("./json-store");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_DARAJA_RESPONSE_BYTES = 64 * 1024;
const MAX_CALLBACK_BYTES = 64 * 1024;

function normalizePhoneNumber(phone) {
  if (typeof phone !== "string") {
    return null;
  }

  let normalized = phone.replace(/[\s()-]/g, "");
  if (normalized.startsWith("+254")) {
    normalized = normalized.slice(1);
  } else if (normalized.startsWith("0")) {
    normalized = `254${normalized.slice(1)}`;
  }
  return /^254[17]\d{8}$/.test(normalized) ? normalized : null;
}

function loadMpesaConfig(environment = process.env) {
  const mpesaEnvironment =
    environment.MPESA_ENVIRONMENT?.trim().toLowerCase() || "sandbox";
  const apiBase =
    mpesaEnvironment === "sandbox"
      ? "https://sandbox.safaricom.co.ke"
      : mpesaEnvironment === "production"
        ? "https://api.safaricom.co.ke"
        : null;
  if (!apiBase) {
    throw new Error("MPESA_ENVIRONMENT must be sandbox or production.");
  }

  const callbackUrl = requiredEnvironment(environment, "MPESA_CALLBACK_URL");
  let parsedCallbackUrl;
  try {
    parsedCallbackUrl = new URL(callbackUrl);
  } catch (error) {
    throw new Error("MPESA_CALLBACK_URL must be a public HTTPS URL.", {
      cause: error,
    });
  }
  if (
    parsedCallbackUrl.protocol !== "https:" ||
    !parsedCallbackUrl.hostname ||
    parsedCallbackUrl.username ||
    parsedCallbackUrl.password ||
    parsedCallbackUrl.hash
  ) {
    throw new Error("MPESA_CALLBACK_URL must be a public HTTPS URL.");
  }

  const transactionType =
    environment.MPESA_TRANSACTION_TYPE?.trim() || "CustomerPayBillOnline";
  if (
    transactionType !== "CustomerPayBillOnline" &&
    transactionType !== "CustomerBuyGoodsOnline"
  ) {
    throw new Error("MPESA_TRANSACTION_TYPE is not supported.");
  }

  const shortcode = requiredEnvironment(environment, "MPESA_SHORTCODE");
  if (!/^\d{5,6}$/.test(shortcode)) {
    throw new Error("MPESA_SHORTCODE must contain 5 or 6 digits.");
  }

  return {
    apiBase,
    callbackUrl,
    transactionType,
    shortcode,
    consumerKey: requiredEnvironment(environment, "MPESA_CONSUMER_KEY"),
    consumerSecret: requiredEnvironment(environment, "MPESA_CONSUMER_SECRET"),
    passkey: requiredEnvironment(environment, "MPESA_PASSKEY"),
  };
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function createMpesaTimestamp(date = new Date()) {
  const nairobiDate = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return (
    nairobiDate.getUTCFullYear().toString() +
    String(nairobiDate.getUTCMonth() + 1).padStart(2, "0") +
    String(nairobiDate.getUTCDate()).padStart(2, "0") +
    String(nairobiDate.getUTCHours()).padStart(2, "0") +
    String(nairobiDate.getUTCMinutes()).padStart(2, "0") +
    String(nairobiDate.getUTCSeconds()).padStart(2, "0")
  );
}

async function readLimitedResponse(response, maximumBytes) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      throw new Error("Daraja response exceeded the allowed size.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestDaraja(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
    const body = await readLimitedResponse(response, MAX_DARAJA_RESPONSE_BYTES);
    return { statusCode: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function parseDarajaJson(body, description) {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON.`, { cause: error });
  }
}

async function fetchAccessToken(config, fetchImpl) {
  const url = new URL(
    "/oauth/v1/generate?grant_type=client_credentials",
    config.apiBase,
  );
  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`,
    "utf8",
  ).toString("base64");
  const result = await requestDaraja(
    fetchImpl,
    url,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${credentials}`,
      },
    },
    10_000,
  );
  const body = parseDarajaJson(result.body, "Daraja authentication");
  if (
    result.statusCode !== 200 ||
    typeof body.access_token !== "string" ||
    body.access_token.length === 0
  ) {
    throw new Error(
      `Daraja authentication failed (HTTP ${result.statusCode}).`,
    );
  }
  return body.access_token;
}

async function initiateStkPush(config, phone, amount, fetchImpl) {
  const accessToken = await fetchAccessToken(config, fetchImpl);
  const timestamp = createMpesaTimestamp();
  const password = Buffer.from(
    `${config.shortcode}${config.passkey}${timestamp}`,
    "utf8",
  ).toString("base64");
  const payload = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: config.transactionType,
    Amount: amount,
    PartyA: phone,
    PartyB: config.shortcode,
    PhoneNumber: phone,
    CallBackURL: config.callbackUrl,
    AccountReference: "ImaraBoysFoundry",
    TransactionDesc: "Sponsorship Contribution",
  };
  const result = await requestDaraja(
    fetchImpl,
    new URL("/mpesa/stkpush/v1/processrequest", config.apiBase),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    15_000,
  );
  const body = parseDarajaJson(result.body, "Daraja STK Push");
  if (
    result.statusCode < 200 ||
    result.statusCode >= 300 ||
    String(body.ResponseCode) !== "0"
  ) {
    throw new Error(
      `Daraja did not accept the STK Push (HTTP ${result.statusCode}).`,
    );
  }
  return {
    checkoutRequestId: boundedString(body.CheckoutRequestID, 128),
    merchantRequestId: boundedString(body.MerchantRequestID, 128),
  };
}

async function updateDonation(recordsStore, donationId, updates) {
  await recordsStore.update((records) => {
    const donation = records.donations.find((entry) => entry.id === donationId);
    if (!donation) {
      throw new Error(`Donation record ${donationId} was not found.`);
    }
    Object.assign(donation, updates);
  });
}

function boundedString(value, maximumLength) {
  return typeof value === "string" ? value.slice(0, maximumLength) : null;
}

function extractCallbackMetadata(callbackMetadata) {
  const allowedFields = new Set([
    "Amount",
    "MpesaReceiptNumber",
    "TransactionDate",
    "PhoneNumber",
  ]);
  const items = callbackMetadata?.Item;
  if (!Array.isArray(items)) {
    return {};
  }

  const result = {};
  for (const item of items) {
    if (
      !item ||
      !allowedFields.has(item.Name) ||
      !(
        (typeof item.Value === "string" && item.Value.length <= 128) ||
        (typeof item.Value === "number" && Number.isFinite(item.Value))
      )
    ) {
      continue;
    }
    result[item.Name] = item.Value;
  }
  return result;
}

function createApp({
  uploadDirectory = path.join(os.homedir(), "ImaraBoysFoundry", "uploads"),
  dataFile = path.join(__dirname, "data", "records.json"),
  mpesaEnvironment = process.env,
  frontendOrigins = process.env.FRONTEND_ORIGINS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch API implementation is required.");
  }

  const app = express();
  const recordsStore = new JsonFileStore(dataFile);
  app.locals.recordsStore = recordsStore;
  const allowedFrontendOrigins = new Set(
    (
      frontendOrigins ||
      "http://127.0.0.1:5500,http://localhost:5500," +
        "http://127.0.0.1:5501,http://localhost:5501"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: 1,
      fields: 4,
      fieldSize: 1024,
      parts: 5,
    },
  });

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use((request, response, next) => {
    response.vary("Origin");
    const origin = request.get("Origin");
    const originAllowed = origin && allowedFrontendOrigins.has(origin);
    if (originAllowed) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        return response.status(403).end();
      }
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Accept, Content-Type",
      );
      return response.status(204).end();
    }
    return next();
  });
  app.use(express.urlencoded({ extended: false, limit: "10kb" }));

  app.get("/health", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    return response.json({ status: "ok" });
  });

  app.get("/api/submissions", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const records = await recordsStore.read();
      const submissions = [
        ...records.mentors.map((application) => ({
          id: application.id,
          type: "mentor",
          createdAt: application.createdAt,
          title: "Mentor application",
        })),
        ...records.donations.map((donation) => ({
          id: donation.id,
          type: "donation",
          createdAt: donation.createdAt,
          title: "Donation submission",
        })),
      ].sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
      return response.json({ submissions });
    } catch (error) {
      console.error("Unable to read submissions.", error);
      return response
        .status(500)
        .json({ error: "Unable to load submissions." });
    }
  });

  app.get(
    "/api/submissions/mentor/:id/profile-picture",
    async (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const records = await recordsStore.read();
        const application = records.mentors.find(
          (entry) => entry.id === request.params.id,
        );
        if (
          !application ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(?:png|jpg)$/.test(
            application.profilePicture,
          )
        ) {
          return response.status(404).end();
        }
        return response.sendFile(
          application.profilePicture,
          { root: uploadDirectory },
          (error) => {
            if (error) {
              next(error);
            }
          },
        );
      } catch (error) {
        console.error("Unable to load a mentor profile picture.", error);
        return response.status(500).end();
      }
    },
  );

  app.get("/api/submissions/:type/:id", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const collection =
      request.params.type === "mentor"
        ? "mentors"
        : request.params.type === "donation"
          ? "donations"
          : null;
    if (!collection) {
      return response.status(404).json({ error: "Submission not found." });
    }

    try {
      const records = await recordsStore.read();
      const record = records[collection].find(
        (entry) => entry.id === request.params.id,
      );
      if (!record) {
        return response.status(404).json({ error: "Submission not found." });
      }

      const submission =
        collection === "mentors"
          ? {
              id: record.id,
              type: "mentor",
              createdAt: record.createdAt,
              name: record.name,
              email: record.email,
              phone: record.phone,
              skill: record.skill,
              status: record.status,
              profilePictureUrl:
                `/api/submissions/mentor/${encodeURIComponent(record.id)}` +
                "/profile-picture",
            }
          : {
              id: record.id,
              type: "donation",
              createdAt: record.createdAt,
              amount: record.amount,
              phone: record.phone,
              status: record.status,
              paymentVerified: false,
            };
      return response.json({ submission });
    } catch (error) {
      console.error("Unable to read a submission.", error);
      return response.status(500).json({ error: "Unable to load submission." });
    }
  });

  app.post("/donate", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");

    const amountText = request.body.amount;
    const amount =
      typeof amountText === "string" && /^\d+$/.test(amountText)
        ? Number(amountText)
        : NaN;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 150_000) {
      return response
        .status(400)
        .send("Enter an amount between KES 1 and KES 150,000.");
    }

    const phone = normalizePhoneNumber(request.body.phone);
    if (!phone) {
      return response.status(400).send("Enter a valid Kenyan mobile number.");
    }

    const now = new Date().toISOString();
    const donation = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      amount,
      phone,
      status: "received",
      checkoutRequestId: null,
      merchantRequestId: null,
      callbackResultCode: null,
      paymentVerified: false,
    };
    try {
      await recordsStore.update((records) => records.donations.push(donation));
    } catch (error) {
      console.error("Unable to save the donation request.", error);
      return response
        .status(500)
        .send("Unable to save your donation request. Please try again later.");
    }

    let config;
    try {
      config = loadMpesaConfig(mpesaEnvironment);
    } catch (error) {
      console.error("M-Pesa configuration is incomplete or invalid.", error);
      try {
        await updateDonation(recordsStore, donation.id, {
          status: "configuration_error",
          updatedAt: new Date().toISOString(),
        });
      } catch (storageError) {
        console.error(
          "Unable to update the donation request status.",
          storageError,
        );
      }
      return response
        .status(503)
        .send("M-Pesa payments are not configured. Please try again later.");
    }

    let stkPush;
    try {
      stkPush = await initiateStkPush(config, phone, amount, fetchImpl);
    } catch (error) {
      console.error("Unable to initiate the M-Pesa STK Push.", error);
      try {
        await updateDonation(recordsStore, donation.id, {
          status: "request_failed",
          updatedAt: new Date().toISOString(),
        });
      } catch (storageError) {
        console.error(
          "Unable to update the donation request status.",
          storageError,
        );
      }
      return response
        .status(502)
        .send("M-Pesa could not accept the request. Please try again later.");
    }

    try {
      await updateDonation(recordsStore, donation.id, {
        ...stkPush,
        status: stkPush.checkoutRequestId
          ? "stk_push_accepted"
          : "accepted_without_reference",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        "Daraja accepted the STK Push, but its details could not be saved.",
        error,
      );
      return response
        .status(500)
        .send(
          "M-Pesa may have accepted the request, but it could not be saved. " +
            "Check your phone before trying again.",
        );
    }

    return response
      .status(202)
      .type("html")
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          "<title>M-Pesa request sent</title><body>" +
          "<h1>M-Pesa request sent</h1>" +
          "<p>Check your phone and complete the payment prompt. " +
          "This message does not confirm that a payment was received.</p>" +
          '<p><a href="index.html">Return to Imara Boys Foundry</a></p>' +
          "</body></html>",
      );
  });

  app.post(
    "/mentor",
    (request, response, next) => {
      upload.single("profilePicture")(request, response, (error) => {
        if (error) {
          return next(error);
        }
        return next();
      });
    },
    async (request, response) => {
      const requiredFields = [
        "mentorName",
        "mentorEmail",
        "mentorPhone",
        "mentorSkill",
      ];
      if (
        requiredFields.some(
          (field) =>
            typeof request.body[field] !== "string" ||
            request.body[field].trim() === "",
        )
      ) {
        return response
          .status(400)
          .send("Complete all mentor application fields.");
      }

      const profilePicture = request.file;
      if (!profilePicture) {
        return response.status(400).send("A profile picture is required.");
      }

      let metadata;
      try {
        metadata = await sharp(profilePicture.buffer, {
          failOn: "error",
          limitInputPixels: MAX_IMAGE_PIXELS,
        }).metadata();
        if (
          !["png", "jpeg"].includes(metadata.format) ||
          !metadata.width ||
          !metadata.height ||
          metadata.width > MAX_IMAGE_DIMENSION ||
          metadata.height > MAX_IMAGE_DIMENSION ||
          metadata.width * metadata.height > MAX_IMAGE_PIXELS
        ) {
          return response
            .status(415)
            .send(
              "Upload a valid PNG or JPEG image no larger than 4096 pixels per side.",
            );
        }
        await sharp(profilePicture.buffer, {
          failOn: "error",
          limitInputPixels: MAX_IMAGE_PIXELS,
        })
          .resize(1, 1)
          .toBuffer();
      } catch {
        return response
          .status(415)
          .send(
            "Upload a valid PNG or JPEG image no larger than 4096 pixels per side.",
          );
      }

      const extension = metadata.format === "png" ? ".png" : ".jpg";
      const applicationId = crypto.randomUUID();
      const storedFileName = `${applicationId}${extension}`;
      const destination = path.join(uploadDirectory, storedFileName);
      await fs.mkdir(uploadDirectory, { recursive: true });
      try {
        await fs.writeFile(destination, profilePicture.buffer, { flag: "wx" });
      } catch (error) {
        try {
          await fs.unlink(destination);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") {
            error.cause = cleanupError;
          }
        }
        throw error;
      }

      const application = {
        id: applicationId,
        createdAt: new Date().toISOString(),
        name: request.body.mentorName.trim(),
        email: request.body.mentorEmail.trim(),
        phone: request.body.mentorPhone.trim(),
        skill: request.body.mentorSkill.trim(),
        profilePicture: storedFileName,
        status: "received",
      };
      try {
        await recordsStore.update((records) =>
          records.mentors.push(application),
        );
      } catch (error) {
        try {
          await fs.unlink(destination);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") {
            error.cause = cleanupError;
          }
        }
        console.error("Unable to save the mentor application.", error);
        return response
          .status(500)
          .send("Unable to save your application. Please try again later.");
      }

      console.info("Saved a mentor application and its profile picture.");
      return response
        .status(200)
        .type("html")
        .send(
          '<!doctype html><html lang="en"><body>' +
            "<p>Thank you. Your mentor application and profile picture were received.</p>" +
            "</body></html>",
        );
    },
  );

  app.post(
    "/mpesa-callback",
    express.raw({ type: "application/json", limit: MAX_CALLBACK_BYTES }),
    async (request, response) => {
      if (!Buffer.isBuffer(request.body)) {
        return response.status(400).send("Invalid M-Pesa callback.");
      }

      let callback;
      try {
        callback = JSON.parse(request.body.toString("utf8"));
      } catch {
        return response.status(400).send("Invalid M-Pesa callback.");
      }

      const stkCallback = callback?.Body?.stkCallback;
      const rawResultCode = stkCallback?.ResultCode;
      const validNumericCode =
        Number.isSafeInteger(rawResultCode) && rawResultCode >= 0;
      const validStringCode =
        typeof rawResultCode === "string" &&
        /^\d+$/.test(rawResultCode) &&
        Number.isSafeInteger(Number(rawResultCode));
      if (!validNumericCode && !validStringCode) {
        return response.status(400).send("Invalid M-Pesa callback.");
      }

      const resultCode = Number(rawResultCode);
      const callbackRecord = {
        id: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        merchantRequestId: boundedString(stkCallback.MerchantRequestID, 128),
        checkoutRequestId: boundedString(stkCallback.CheckoutRequestID, 128),
        resultCode,
        resultDescription: boundedString(stkCallback.ResultDesc, 512),
        metadata: extractCallbackMetadata(stkCallback.CallbackMetadata),
        paymentVerified: false,
      };
      try {
        await recordsStore.update((records) => {
          records.callbacks.push(callbackRecord);
          const donation = records.donations.find(
            (entry) =>
              callbackRecord.checkoutRequestId &&
              entry.checkoutRequestId === callbackRecord.checkoutRequestId,
          );
          if (donation) {
            Object.assign(donation, {
              status: "callback_received_unverified",
              callbackId: callbackRecord.id,
              callbackReceivedAt: callbackRecord.receivedAt,
              callbackResultCode: resultCode,
              callbackMetadata: callbackRecord.metadata,
              paymentVerified: false,
              updatedAt: callbackRecord.receivedAt,
            });
          }
        });
      } catch (error) {
        console.error("Unable to save the M-Pesa callback.", error);
        return response.status(500).send("Unable to save the M-Pesa callback.");
      }

      console.info(
        `M-Pesa callback received with ResultCode=${resultCode}. ` +
          "The callback is not recorded as verified payment.",
      );
      return response.status(200).end();
    },
  );

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      return next(error);
    }
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "The image must be 5 MB or smaller."
          : "Invalid mentor application upload.";
      return response.status(status).send(message);
    }
    if (error.status === 413 || error.type === "entity.too.large") {
      return response.status(413).send("Request is too large.");
    }
    console.error("Request failed.", error);
    return response.status(500).send("The request could not be completed.");
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const app = createApp();
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("PORT must be a number between 0 and 65535.");
    process.exitCode = 1;
  } else {
    app.locals.recordsStore
      .initialize()
      .then(() => {
        const server = app.listen(port, host, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            console.error(
              "Unable to determine the backend's listening address.",
            );
            process.exitCode = 1;
            return;
          }
          console.info(
            `Imara Boys Foundry backend is listening at ` +
              `http://${host}:${address.port}`,
          );
        });
        server.on("error", (error) => {
          console.error(
            `Unable to start the backend at http://${host}:${port}.`,
            error,
          );
          process.exitCode = 1;
        });
      })
      .catch((error) => {
        console.error("Unable to initialize JSON storage.", error);
        process.exitCode = 1;
      });
  }
}

module.exports = {
  createApp,
  createMpesaTimestamp,
  loadMpesaConfig,
  normalizePhoneNumber,
};
