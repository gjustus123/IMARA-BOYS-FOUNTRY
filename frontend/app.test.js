"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

class TestFormData {
  constructor(form) {
    this.entries = form.entries;
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
  }
}

function createForm(type, action, entries) {
  const listeners = {};
  const status = {
    hidden: true,
    textContent: "",
    dataset: {},
    setAttribute(name, value) {
      this[name] = value;
    },
  };
  const button = { disabled: false, textContent: "Submit" };
  return {
    action,
    dataset: { apiForm: type },
    entries,
    listeners,
    status,
    button,
    resetCount: 0,
    querySelector(selector) {
      return selector === "[data-form-status]" ? status : button;
    },
    addEventListener(name, callback) {
      listeners[name] = callback;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    removeAttribute(name) {
      delete this[name];
    },
    reset() {
      this.resetCount++;
    },
  };
}

function loadFrontend(forms, fetchImpl) {
  const script = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  vm.runInNewContext(script, {
    document: {
      querySelectorAll: () => forms,
    },
    FormData: TestFormData,
    URLSearchParams,
    URL,
    fetch: fetchImpl,
    TypeError,
    window: { API_BASE_URL: "http://127.0.0.1:3000" },
  });
}

function submit(form) {
  let defaultPrevented = false;
  form.listeners.submit({
    preventDefault() {
      defaultPrevented = true;
    },
  });
  assert.equal(defaultPrevented, true);
  return new Promise((resolve) => setImmediate(resolve));
}

test("donation form sends URL-encoded data and shows the API result", async () => {
  let request;
  const form = createForm("donate", "http://localhost:3000/donate", [
    ["amount", "1000"],
    ["phone", "0712345678"],
  ]);
  loadFrontend([form], async (url, options) => {
    request = { url, options };
    return { ok: true, status: 202 };
  });

  await submit(form);

  assert.equal(request.url, "http://127.0.0.1:3000/donate");
  assert.equal(request.options.method, "POST");
  assert.match(
    request.options.headers["Content-Type"],
    /^application\/x-www-form-urlencoded/,
  );
  assert.equal(String(request.options.body), "amount=1000&phone=0712345678");
  assert.equal(form.status.dataset.state, "success");
  assert.match(form.status.textContent, /Check your phone/);
  assert.equal(form.resetCount, 1);
  assert.equal(form.button.disabled, false);
});

test("mentor form sends multipart data without setting its content type", async () => {
  let request;
  const form = createForm("mentor", "http://localhost:3000/mentor", [
    ["mentorName", "Test Mentor"],
    ["profilePicture", "test-image"],
  ]);
  loadFrontend([form], async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  });

  await submit(form);

  assert.equal(request.url, "http://127.0.0.1:3000/mentor");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], undefined);
  assert.ok(request.options.body instanceof TestFormData);
  assert.equal(form.status.dataset.state, "success");
  assert.match(form.status.textContent, /application was received/);
  assert.equal(form.resetCount, 1);
});
