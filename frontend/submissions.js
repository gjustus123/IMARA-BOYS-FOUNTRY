"use strict";

const API_BASE_URL = window.API_BASE_URL.replace(/\/+$/, "");
const submissionsList = document.querySelector("[data-submissions-list]");
const submissionsStatus = document.querySelector("[data-submissions-status]");
const submissionDateFormat = new Intl.DateTimeFormat("en-KE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Nairobi",
});

loadSubmissions();

async function loadSubmissions() {
  try {
    const response = await fetch(backendUrl("/api/submissions"), {
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Unable to load submissions.");
    }

    if (!Array.isArray(result.submissions)) {
      throw new Error("The server returned an invalid submissions list.");
    }
    if (result.submissions.length === 0) {
      submissionsStatus.textContent = "There are no submissions yet.";
      return;
    }

    submissionsStatus.textContent = `${result.submissions.length} submission(s). Select one to view its details.`;
    for (const submission of result.submissions) {
      submissionsList.append(createSubmissionEntry(submission));
    }
  } catch (error) {
    submissionsStatus.textContent = error.message;
    submissionsStatus.dataset.state = "error";
  }
}

function createSubmissionEntry(submission) {
  const article = document.createElement("article");
  article.className = "submission-card";

  const button = document.createElement("button");
  button.className = "submission-toggle";
  button.type = "button";
  button.setAttribute("aria-expanded", "false");

  const title = document.createElement("span");
  title.className = "submission-title";
  title.textContent =
    submission.type === "mentor" ? "Mentor application" : "Donation submission";

  const date = document.createElement("time");
  date.className = "submission-date";
  date.dateTime = submission.createdAt || "";
  date.textContent = formatSubmissionDate(submission.createdAt);

  const details = document.createElement("div");
  details.className = "submission-details";
  details.hidden = true;

  button.append(title, date);
  button.addEventListener("click", () =>
    toggleSubmissionDetails(button, details, submission),
  );
  article.append(button, details);
  return article;
}

async function toggleSubmissionDetails(button, details, submission) {
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  details.hidden = expanded;
  if (expanded || details.dataset.loaded === "true") {
    return;
  }

  details.textContent = "Loading details...";
  try {
    const response = await fetch(
      backendUrl(
        `/api/submissions/${encodeURIComponent(submission.type)}/${encodeURIComponent(submission.id)}`,
      ),
      {
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
      },
    );
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Unable to load this submission.");
    }
    if (!result.submission) {
      throw new Error("The server returned an invalid submission.");
    }
    renderSubmissionDetails(details, result.submission);
    details.dataset.loaded = "true";
  } catch (error) {
    details.textContent = error.message;
  }
}

function renderSubmissionDetails(container, submission) {
  container.replaceChildren();
  const fields =
    submission.type === "mentor"
      ? [
          ["Name", submission.name],
          ["Email", submission.email],
          ["Phone", submission.phone],
          ["Skill", submission.skill],
          ["Status", submission.status],
        ]
      : [
          ["Amount", `KES ${submission.amount}`],
          ["Phone", submission.phone],
          ["Status", submission.status],
          ["Payment verified", submission.paymentVerified ? "Yes" : "No"],
        ];

  const list = document.createElement("dl");
  list.className = "submission-fields";
  for (const [label, value] of fields) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value == null ? "Not provided" : String(value);
    list.append(term, description);
  }
  container.append(list);

  if (submission.type === "mentor" && submission.profilePictureUrl) {
    const image = document.createElement("img");
    image.className = "submission-photo";
    image.src = backendUrl(submission.profilePictureUrl);
    image.alt = `Profile picture for ${submission.name}`;
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), { once: true });
    container.append(image);
  }
}

function formatSubmissionDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : submissionDateFormat.format(date);
}

function backendUrl(path) {
  return new URL(path, `${API_BASE_URL}/`).href;
}
