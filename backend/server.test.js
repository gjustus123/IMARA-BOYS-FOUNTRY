"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const sharp = require("sharp");
const test = require("node:test");
const {
  createApp,
  createMpesaTimestamp,
  loadMpesaConfig,
  normalizePhoneNumber,
} = require("./server");

async function startTestServer(t, options) {
  const app = createApp(options);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("normalizes supported Kenyan phone number forms", () => {
  assert.equal(normalizePhoneNumber("0712 345 678"), "254712345678");
  assert.equal(normalizePhoneNumber("+254 112-345-678"), "254112345678");
  assert.equal(normalizePhoneNumber("254712345678"), "254712345678");
  assert.equal(normalizePhoneNumber("0612345678"), null);
});

test("requires a public HTTPS callback URL for M-Pesa configuration", () => {
  const environment = {
    MPESA_CONSUMER_KEY: "key",
    MPESA_CONSUMER_SECRET: "secret",
    MPESA_SHORTCODE: "174379",
    MPESA_PASSKEY: "passkey",
    MPESA_CALLBACK_URL: "http://localhost/callback",
  };
  assert.throws(() => loadMpesaConfig(environment), /public HTTPS URL/);
});

test("formats the Daraja timestamp in Nairobi time", () => {
  assert.equal(
    createMpesaTimestamp(new Date("2026-01-02T03:04:05.000Z")),
    "20260102060405",
  );
});

test("provides a backend health check and allows the separate frontend origin", async (t) => {
  const baseUrl = await startTestServer(t);
  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: "ok" });

  const frontendOrigin = "http://127.0.0.1:5500";
  const preflightResponse = await fetch(`${baseUrl}/mentor`, {
    method: "OPTIONS",
    headers: {
      Origin: frontendOrigin,
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(preflightResponse.status, 204);
  assert.equal(
    preflightResponse.headers.get("access-control-allow-origin"),
    frontendOrigin,
  );
  assert.match(
    preflightResponse.headers.get("access-control-allow-methods"),
    /POST/,
  );

  const rejectedOriginResponse = await fetch(`${baseUrl}/health`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://not-allowed.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(rejectedOriginResponse.status, 403);
});

test("rejects an invalid donation amount without calling Daraja", async (t) => {
  const baseUrl = await startTestServer(t, {
    fetchImpl: () => {
      throw new Error("Daraja must not be called for invalid amounts.");
    },
  });
  const response = await fetch(`${baseUrl}/donate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ amount: "150001", phone: "0712345678" }),
  });
  assert.equal(response.status, 400);
});

test("sends a validated donation to the mocked Daraja endpoints", async (t) => {
  const dataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imara-donation-test-"),
  );
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const dataFile = path.join(dataDirectory, "records.json");
  const mpesaEnvironment = {
    MPESA_ENVIRONMENT: "sandbox",
    MPESA_CONSUMER_KEY: "test-key",
    MPESA_CONSUMER_SECRET: "test-secret",
    MPESA_SHORTCODE: "174379",
    MPESA_PASSKEY: "test-passkey",
    MPESA_CALLBACK_URL: "https://example.test/mpesa-callback",
  };

  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (new URL(url).pathname === "/oauth/v1/generate") {
      return new Response(JSON.stringify({ access_token: "mock-token" }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        ResponseCode: "0",
        CheckoutRequestID: "checkout-test-123",
        MerchantRequestID: "merchant-test-123",
      }),
      { status: 200 },
    );
  };
  const baseUrl = await startTestServer(t, {
    dataFile,
    fetchImpl,
    mpesaEnvironment,
  });
  const response = await fetch(`${baseUrl}/donate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ amount: "1000", phone: "0712345678" }),
  });

  assert.equal(response.status, 202);
  assert.match(await response.text(), /M-Pesa request sent/);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].url.origin + requests[1].url.pathname,
    "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
  );
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.Amount, 1000);
  assert.equal(payload.PartyA, "254712345678");
  assert.equal(payload.CallBackURL, "https://example.test/mpesa-callback");
  const records = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(records.donations.length, 1);
  assert.equal(records.donations[0].amount, 1000);
  assert.equal(records.donations[0].phone, "254712345678");
  assert.equal(records.donations[0].status, "stk_push_accepted");
  assert.equal(records.donations[0].checkoutRequestId, "checkout-test-123");
});

test("accepts a mentor application and stores a validated image", async (t) => {
  const dataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imara-mentor-test-"),
  );
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const uploadDirectory = path.join(dataDirectory, "uploads");
  const dataFile = path.join(dataDirectory, "records.json");
  const baseUrl = await startTestServer(t, { dataFile, uploadDirectory });
  const image = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 0, g: 120, b: 80 },
    },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("mentorName", "Test Mentor");
  form.set("mentorEmail", "mentor@example.test");
  form.set("mentorPhone", "0712345678");
  form.set("mentorSkill", "IT");
  form.set(
    "profilePicture",
    new Blob([image], { type: "image/png" }),
    "profile.png",
  );

  const response = await fetch(`${baseUrl}/mentor`, {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 200);
  assert.match(
    await response.text(),
    /application and profile picture were received/,
  );
  const savedFiles = await fs.readdir(uploadDirectory);
  assert.equal(savedFiles.length, 1);
  assert.match(savedFiles[0], /^[0-9a-f-]{36}\.png$/);
  const records = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(records.mentors.length, 1);
  assert.equal(records.mentors[0].name, "Test Mentor");
  assert.equal(records.mentors[0].email, "mentor@example.test");
  assert.equal(records.mentors[0].profilePicture, savedFiles[0]);

  const detailResponse = await fetch(
    `${baseUrl}/api/submissions/mentor/${records.mentors[0].id}`,
  );
  assert.equal(detailResponse.status, 200);
  const { submission } = await detailResponse.json();
  assert.equal(submission.name, "Test Mentor");
  assert.equal(submission.email, "mentor@example.test");
  assert.equal(
    submission.profilePictureUrl,
    `/api/submissions/mentor/${records.mentors[0].id}/profile-picture`,
  );
  const imageResponse = await fetch(
    `${baseUrl}${submission.profilePictureUrl}`,
  );
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get("content-type"), /image\/png/);
});

test("lists submissions newest first and returns selected donation details", async (t) => {
  const dataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imara-submissions-test-"),
  );
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const dataFile = path.join(dataDirectory, "records.json");
  await fs.writeFile(
    dataFile,
    JSON.stringify({
      mentors: [
        {
          id: "mentor-test-123",
          createdAt: "2026-01-01T10:00:00.000Z",
          name: "Test Mentor",
          email: "mentor@example.test",
          phone: "0712345678",
          skill: "IT",
          status: "received",
          profilePicture: "profile.png",
        },
      ],
      donations: [
        {
          id: "donation-test-123",
          createdAt: "2026-01-02T10:00:00.000Z",
          amount: 500,
          phone: "254712345678",
          status: "configuration_error",
          paymentVerified: false,
        },
      ],
      callbacks: [],
    }),
  );
  const baseUrl = await startTestServer(t, { dataFile });

  const listResponse = await fetch(`${baseUrl}/api/submissions`);
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get("cache-control"), "no-store");
  const { submissions } = await listResponse.json();
  assert.deepEqual(
    submissions.map(({ type, id }) => [type, id]),
    [
      ["donation", "donation-test-123"],
      ["mentor", "mentor-test-123"],
    ],
  );
  assert.equal(Object.hasOwn(submissions[0], "phone"), false);

  const detailResponse = await fetch(
    `${baseUrl}/api/submissions/donation/donation-test-123`,
  );
  assert.equal(detailResponse.status, 200);
  const { submission } = await detailResponse.json();
  assert.equal(submission.amount, 500);
  assert.equal(submission.phone, "254712345678");
  assert.equal(submission.paymentVerified, false);

  const missingResponse = await fetch(
    `${baseUrl}/api/submissions/donation/missing`,
  );
  assert.equal(missingResponse.status, 404);
});

test("rejects malformed M-Pesa callback JSON", async (t) => {
  const baseUrl = await startTestServer(t);
  const response = await fetch(`${baseUrl}/mpesa-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(response.status, 400);
});

test("stores callbacks and leaves matched donations unverified", async (t) => {
  const dataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imara-callback-test-"),
  );
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const dataFile = path.join(dataDirectory, "records.json");
  await fs.writeFile(
    dataFile,
    JSON.stringify({
      mentors: [],
      donations: [
        {
          id: "donation-test-123",
          checkoutRequestId: "checkout-test-123",
          status: "stk_push_accepted",
        },
      ],
      callbacks: [],
    }),
  );
  const baseUrl = await startTestServer(t, { dataFile });
  const response = await fetch(`${baseUrl}/mpesa-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Body: {
        stkCallback: {
          CheckoutRequestID: "checkout-test-123",
          MerchantRequestID: "merchant-test-123",
          ResultCode: 0,
          ResultDesc: "Success",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 100 },
              { Name: "MpesaReceiptNumber", Value: "QAB123" },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  const records = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(records.callbacks.length, 1);
  assert.equal(records.callbacks[0].paymentVerified, false);
  assert.equal(records.callbacks[0].metadata.MpesaReceiptNumber, "QAB123");
  assert.equal(records.donations[0].status, "callback_received_unverified");
  assert.equal(records.donations[0].paymentVerified, false);
});

test("records donation requests when M-Pesa configuration is missing", async (t) => {
  const dataDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imara-unconfigured-donation-test-"),
  );
  t.after(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const dataFile = path.join(dataDirectory, "records.json");
  const baseUrl = await startTestServer(t, {
    dataFile,
    fetchImpl: () => {
      throw new Error("Daraja must not be called without configuration.");
    },
    mpesaEnvironment: {},
  });
  const response = await fetch(`${baseUrl}/donate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ amount: "500", phone: "0712345678" }),
  });

  assert.equal(response.status, 503);
  const records = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(records.donations.length, 1);
  assert.equal(records.donations[0].status, "configuration_error");
  assert.equal(records.donations[0].amount, 500);
});
