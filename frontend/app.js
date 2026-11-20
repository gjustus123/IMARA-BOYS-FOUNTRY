"use strict";

const API_BASE_URL = window.API_BASE_URL.replace(/\/+$/, "");

const formMessages = {
  donate: {
    pending: "Sending the M-Pesa request...",
    success:
      "Request accepted. Check your phone and complete the M-Pesa prompt. This does not confirm that payment was received.",
  },
  mentor: {
    pending: "Submitting your application...",
    success: "Thank you. Your mentor application was received.",
  },
};

document.querySelectorAll("form[data-api-form]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(form);
  });
});

async function submitForm(form) {
  const formType = form.dataset.apiForm;
  const messages = formMessages[formType];
  const status = form.querySelector("[data-form-status]");
  const submitButton = form.querySelector('button[type="submit"]');

  if (!messages || !status || !submitButton || submitButton.disabled) {
    return;
  }

  const originalButtonText = submitButton.textContent;
  status.hidden = true;
  status.textContent = "";
  submitButton.disabled = true;
  submitButton.textContent =
    formType === "donate" ? "Sending request..." : "Submitting...";
  form.setAttribute("aria-busy", "true");

  try {
    const formPath = new URL(form.action, `${API_BASE_URL}/`).pathname;
    const apiUrl = new URL(formPath, `${API_BASE_URL}/`).href;
    const options = {
      method: "POST",
      headers: { Accept: "text/plain, text/html" },
      credentials: "omit",
    };

    if (formType === "donate") {
      options.headers["Content-Type"] =
        "application/x-www-form-urlencoded;charset=UTF-8";
      options.body = new URLSearchParams(new FormData(form));
    } else {
      options.body = new FormData(form);
    }

    const response = await fetch(apiUrl, options);
    if (!response.ok) {
      const errorMessage = (await response.text()).trim();
      throw new Error(
        errorMessage || `The server returned an error (${response.status}).`,
      );
    }

    form.reset();
    showStatus(status, messages.success, "success");
  } catch (error) {
    const message =
      error instanceof TypeError
        ? "Could not connect to the server. Check your connection and try again."
        : error.message;
    showStatus(status, message, "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;
    form.removeAttribute("aria-busy");
  }
}

function showStatus(status, message, state) {
  status.textContent = message;
  status.dataset.state = state;
  status.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
  status.hidden = false;
}
