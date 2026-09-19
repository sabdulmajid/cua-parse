import "dotenv/config";
/** Opt-in voice connection check using Chrome's synthetic microphone. */
import { chromium, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();
let audioFrames = 0,
  bound = false,
  requestedVoice = false,
  status = "FAIL";
page.on("request", (r) => {
  if (r.url().endsWith("/api/voice/session"))
    requestedVoice = r.postDataJSON()?.mode === "voice";
});
page.on("response", (r) => {
  if (r.url().endsWith("/api/voice/bind") && r.ok()) bound = true;
});
page.on("websocket", (socket) =>
  socket.on("framereceived", ({ payload }) => {
    try {
      if (JSON.parse(String(payload)).type === "audio") audioFrames++;
    } catch {
      /* Never log raw frames or credential URLs. */
    }
  }),
);
try {
  await page.goto(process.env.APP_BASE_URL || "http://127.0.0.1:3000");
  await page.getByRole("button", { name: "Talk", exact: true }).click();
  await expect.poll(() => bound, { timeout: 30000 }).toBe(true);
  await expect.poll(() => audioFrames, { timeout: 30000 }).toBeGreaterThan(0);
  expect(requestedVoice).toBe(true);
  await page
    .getByRole("button", { name: "Stop conversation", exact: true })
    .click();
  status = "PASS";
} catch {
  console.error(
    "Voice connection smoke did not meet all assertions. Raw provider errors are not logged.",
  );
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  const report = {
    status,
    observedAt: new Date().toISOString(),
    requestedVoice,
    bound,
    receivedAudioFrames: audioFrames,
    microphone: "Chrome synthetic input",
    limitation:
      "This verifies private voice connection and real provider audio receipt. Physical microphone, speech recognition accuracy, audible quality and interruption still need a person to check.",
  };
  writeFileSync(
    ".local/voice-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
