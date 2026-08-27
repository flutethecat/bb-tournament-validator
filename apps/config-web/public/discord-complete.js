"use strict";

const title = document.querySelector("#completion-title");
const status = document.querySelector("#status");
const form = document.querySelector("#completion-form");
const discordUsername = document.querySelector("#discord-username");
const discordEmail = document.querySelector("#discord-email");
const ffbCoachId = document.querySelector("#ffb-coach-id");
const forkPasswordField = document.querySelector("#fork-password-field");
const forkPassword = document.querySelector("#fork-password");
const nameAvailability = document.querySelector("#name-availability");
const submitButton = document.querySelector("#submit-button");
const success = document.querySelector("#success");

let availabilityRequest = 0;
let availabilityTimer;
let chosenNameAvailable = false;
let linkingExistingCoach = false;
let nameChecked = false;

function updateSubmitState() {
  submitButton.disabled = !nameChecked || (linkingExistingCoach && !forkPassword.value);
}

function setLinkingMode(enabled) {
  linkingExistingCoach = enabled;
  forkPasswordField.hidden = !enabled;
  forkPassword.required = enabled;
  updateSubmitState();
}

class RequestError extends Error {
  constructor(message, responseStatus, data) {
    super(message);
    this.responseStatus = responseStatus;
    this.data = data;
  }
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    // The status fallback below does not expose response text.
  }
  if (!response.ok) {
    throw new RequestError(
      typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`,
      response.status,
      data,
    );
  }
  return data;
}

function showError(error) {
  status.hidden = false;
  status.textContent = error instanceof Error ? error.message : String(error);
}

async function checkAvailability() {
  const coach = ffbCoachId.value.trim();
  const request = ++availabilityRequest;
  chosenNameAvailable = false;
  nameChecked = false;
  setLinkingMode(false);
  if (!coach) {
    nameAvailability.textContent = "Enter a coach name.";
    return false;
  }
  if (coach.length > 40) {
    nameAvailability.textContent = "Coach names must be at most 40 characters.";
    return false;
  }
  nameAvailability.textContent = "Checking availability…";
  try {
    const result = await requestJson(`/api/fork/name-available?coach=${encodeURIComponent(coach)}`);
    if (request !== availabilityRequest || coach !== ffbCoachId.value.trim()) return false;
    chosenNameAvailable = result.available === true;
    nameChecked = true;
    setLinkingMode(result.canLink === true);
    if (linkingExistingCoach) {
      nameAvailability.textContent = "That coach already exists. Enter its fork password to link it without changing the account.";
    } else {
      nameAvailability.textContent = chosenNameAvailable
        ? "That coach name is available."
        : "That coach name is already taken. Continue to check whether it can be linked.";
    }
    updateSubmitState();
    return true;
  } catch (error) {
    if (request !== availabilityRequest) return false;
    nameAvailability.textContent = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function completeSignIn(coach, password) {
  return requestJson("/api/auth/discord/complete", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cw-auth": "1" },
    body: JSON.stringify({ ffbCoachId: coach, ...(password ? { password } : {}) }),
  });
}

function finishSignIn(result, fallbackCoach) {
  const coach = typeof result.coach === "string" ? result.coach : fallbackCoach;
  form.hidden = true;
  status.hidden = true;
  success.hidden = false;
  success.textContent = `You're signed in as ${coach}.`;
  location.assign(typeof result.next === "string" ? result.next : "/");
}

async function initialize() {
  const callbackError = new URLSearchParams(location.search).get("error");
  if (callbackError === "host-browser-mismatch") {
    title.textContent = "Discord sign-in browser mismatch";
    showError(
      `This sign-in did not return to the browser or profile that started it. ` +
      `Config-Web must use ${location.host}. Open Config-Web at ${location.origin}/ and try again in the same browser/profile.`,
    );
    return;
  }
  if (callbackError === "expired") {
    title.textContent = "Discord sign-in expired";
    showError(`This Discord sign-in expired. Open Config-Web at ${location.origin}/ and start again.`);
    return;
  }
  if (callbackError === "invalid-state") {
    title.textContent = "Discord sign-in could not be verified";
    showError(`Invalid Discord OAuth state. Start again from ${location.origin}/.`);
    return;
  }

  try {
    const pending = await requestJson("/api/auth/discord/pending");
    const username = typeof pending.discordUsername === "string" ? pending.discordUsername : "";
    const email = typeof pending.email === "string" ? pending.email : "";
    const existingFfbCoachId = typeof pending.existingFfbCoachId === "string"
      ? pending.existingFfbCoachId
      : null;

    discordUsername.value = username;
    discordEmail.value = email || "Not provided as a verified email";
    if (existingFfbCoachId) {
      title.textContent = `Signing in as ${existingFfbCoachId}`;
      status.textContent = "Completing your Discord sign-in…";
      finishSignIn(await completeSignIn(existingFfbCoachId), existingFfbCoachId);
      return;
    }

    title.textContent = "Link or register your fork coach account";
    ffbCoachId.value = username;
    status.hidden = true;
    form.hidden = false;
    ffbCoachId.focus();
    await checkAvailability();
  } catch (error) {
    title.textContent = "Discord verification unavailable";
    showError(error);
  }
}

ffbCoachId.addEventListener("input", () => {
  clearTimeout(availabilityTimer);
  chosenNameAvailable = false;
  nameChecked = false;
  forkPassword.value = "";
  setLinkingMode(false);
  nameAvailability.textContent = "Waiting to check availability…";
  availabilityTimer = setTimeout(() => void checkAvailability(), 250);
});

forkPassword.addEventListener("input", updateSubmitState);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(availabilityTimer);
  const coach = ffbCoachId.value.trim();
  if (!nameChecked && !(await checkAvailability())) {
    showError(new Error("Enter a valid fork coach name."));
    return;
  }
  if (linkingExistingCoach && !forkPassword.value) {
    showError(new Error("Enter the existing fork password to link this coach."));
    return;
  }

  submitButton.disabled = true;
  status.hidden = false;
  status.textContent = linkingExistingCoach
    ? "Verifying and linking your existing fork account…"
    : chosenNameAvailable
      ? "Creating your fork account…"
      : "Checking whether this fork account can be linked…";
  try {
    finishSignIn(await completeSignIn(coach, linkingExistingCoach ? forkPassword.value : undefined), coach);
  } catch (error) {
    showError(error);
    if (error instanceof RequestError && error.data?.canLink === true) {
      nameChecked = true;
      chosenNameAvailable = false;
      setLinkingMode(true);
      nameAvailability.textContent = "That coach already exists. Enter its fork password to link it without changing the account.";
      forkPassword.focus();
    } else {
      updateSubmitState();
    }
  }
});

void initialize();
