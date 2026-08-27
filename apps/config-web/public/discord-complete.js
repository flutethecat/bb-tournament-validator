"use strict";

const title = document.querySelector("#completion-title");
const status = document.querySelector("#status");
const form = document.querySelector("#completion-form");
const discordUsername = document.querySelector("#discord-username");
const discordEmail = document.querySelector("#discord-email");
const ffbCoachId = document.querySelector("#ffb-coach-id");
const nameAvailability = document.querySelector("#name-availability");
const submitButton = document.querySelector("#submit-button");
const success = document.querySelector("#success");

let availabilityRequest = 0;
let availabilityTimer;
let chosenNameAvailable = false;

async function requestJson(path, options) {
  const response = await fetch(path, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    // The status fallback below does not expose response text.
  }
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`);
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
  submitButton.disabled = true;
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
    nameAvailability.textContent = chosenNameAvailable
      ? "That coach name is available."
      : "That coach name is already taken.";
    submitButton.disabled = !chosenNameAvailable;
    return chosenNameAvailable;
  } catch (error) {
    if (request !== availabilityRequest) return false;
    nameAvailability.textContent = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function completeSignIn(coach) {
  return requestJson("/api/auth/discord/complete", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cw-auth": "1" },
    body: JSON.stringify({ ffbCoachId: coach }),
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

    title.textContent = "Register your fork coach account";
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
  submitButton.disabled = true;
  nameAvailability.textContent = "Waiting to check availability…";
  availabilityTimer = setTimeout(() => void checkAvailability(), 250);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(availabilityTimer);
  const coach = ffbCoachId.value.trim();
  if (!chosenNameAvailable && !(await checkAvailability())) {
    showError(new Error("Choose an available fork coach name."));
    return;
  }

  submitButton.disabled = true;
  status.hidden = false;
  status.textContent = "Creating your fork account…";
  try {
    finishSignIn(await completeSignIn(coach), coach);
  } catch (error) {
    showError(error);
    await checkAvailability();
  }
});

void initialize();
