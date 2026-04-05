import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const baseUrl = process.env.T3CODE_BASE_URL ?? "http://127.0.0.1:4312";
const artifactDir =
  process.env.T3CODE_ARTIFACT_DIR ?? "d:/Projects/t3code/.tmp/playwright-opencode-e2e-verify-2";
const screenshotPath = path.join(artifactDir, "live-opencode-result.png");
const htmlPath = path.join(artifactDir, "live-opencode-result.html");
const runToken = Date.now().toString(36);
const assistantReplyOne = `LIVE_VERIFY_ONE_${runToken}`;
const assistantReplyTwo = `LIVE_VERIFY_TWO_${runToken}`;

await fs.mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

page.on("console", (message) => {
  console.log(`BROWSER_CONSOLE ${message.type()} ${message.text()}`);
});

page.on("pageerror", (error) => {
  console.log(`PAGE_ERROR ${error.stack ?? error.message}`);
});

function compactText(value) {
  return value.replace(/\s+/g, " ").trim();
}

async function dumpState(tag) {
  const bodyText = compactText(await page.locator("body").innerText());
  const buttons = await page.locator("button").evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent?.trim() ?? "",
      aria: node.getAttribute("aria-label") ?? "",
      disabled: node.hasAttribute("disabled"),
    })),
  );
  const assistantMessages = await page
    .locator('[data-message-role="assistant"]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));

  console.log(`${tag}_URL`, page.url());
  console.log(`${tag}_BUTTONS`, JSON.stringify(buttons, null, 2));
  console.log(`${tag}_ASSISTANT_MESSAGES`, JSON.stringify(assistantMessages, null, 2));
  console.log(`${tag}_BODY`, bodyText.slice(0, 4_000));
}

async function waitForComposer() {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 60_000 });
  return editor;
}

async function createFreshThreadIfPossible() {
  const createThreadButton = page.locator('button[aria-label^="Create new thread in "]').first();
  if ((await createThreadButton.count()) === 0) {
    return;
  }

  const beforeUrl = page.url();
  await createThreadButton.click();
  await page.waitForTimeout(1_000);
  await waitForComposer();
  const afterUrl = page.url();
  console.log("THREAD_URL_BEFORE", beforeUrl);
  console.log("THREAD_URL_AFTER", afterUrl);
}

async function providerPicker() {
  const picker = page.locator('[data-chat-provider-model-picker="true"]').first();
  await picker.waitFor({ state: "visible", timeout: 60_000 });
  return picker;
}

async function logMenuItems(tag) {
  const items = await page
    .locator('[role="menuitem"], [role="menuitemradio"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        role: node.getAttribute("role"),
        text: node.textContent?.trim() ?? "",
      })),
    );
  console.log(tag, JSON.stringify(items, null, 2));
}

async function selectOpenCode() {
  const picker = await providerPicker();
  const beforeText = compactText((await picker.textContent()) ?? "");
  console.log("PICKER_BEFORE", beforeText);

  if (beforeText.includes("OpenCode")) {
    return;
  }

  await picker.click();
  await page.waitForTimeout(400);
  await logMenuItems("MENU_AFTER_PICKER_OPEN");

  const openCodeProvider = page
    .locator('[role="menuitem"]')
    .filter({ hasText: "OpenCode" })
    .first();
  if ((await openCodeProvider.count()) > 0) {
    await openCodeProvider.hover();
    await page.waitForTimeout(400);
    await logMenuItems("MENU_AFTER_OPENCODE_HOVER");
    await openCodeProvider.click();
    await page.waitForTimeout(400);
    await logMenuItems("MENU_AFTER_OPENCODE_CLICK");
  }

  const openCodeModel = page
    .locator('button, [role="menuitemradio"], [role="menuitem"]')
    .filter({ hasText: /^OpenCode\s.+/i })
    .first();

  if ((await openCodeModel.count()) > 0) {
    console.log("SELECTING_MODEL", compactText((await openCodeModel.textContent()) ?? ""));
    await openCodeModel.click();
  } else {
    throw new Error("Unable to find an OpenCode provider or model option in the picker.");
  }

  await page.waitForTimeout(800);
  const afterText = compactText((await picker.textContent()) ?? "");
  console.log("PICKER_AFTER", afterText);

  if (afterText === beforeText) {
    throw new Error(
      `Provider picker did not change after selecting OpenCode. Current text: ${afterText}`,
    );
  }
}

async function setComposerText(value) {
  const editor = await waitForComposer();
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(value);
}

async function sendPrompt(prompt) {
  await setComposerText(prompt);
  const sendButton = page.locator('button[aria-label="Send message"]').first();
  await sendButton.waitFor({ state: "visible", timeout: 30_000 });
  await sendButton.click();
  console.log("SENT_PROMPT", prompt);
}

async function waitForAssistantText(text) {
  await page
    .locator('[data-message-role="assistant"]')
    .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) })
    .first()
    .waitFor({ state: "visible", timeout: 180_000 });
  console.log(`OBSERVED_${text}`);
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForComposer();
  await createFreshThreadIfPossible();
  await providerPicker();
  await dumpState("INITIAL");

  await selectOpenCode();

  await sendPrompt(`Reply with exactly ${assistantReplyOne} and nothing else.`);
  await waitForAssistantText(assistantReplyOne);
  await page
    .locator('button[aria-label="Send message"]')
    .first()
    .waitFor({ state: "visible", timeout: 180_000 });

  await sendPrompt(`Reply with exactly ${assistantReplyTwo} and nothing else.`);
  await waitForAssistantText(assistantReplyTwo);
  await page
    .locator('button[aria-label="Send message"]')
    .first()
    .waitFor({ state: "visible", timeout: 180_000 });

  await dumpState("SUCCESS");
  console.log("PLAYWRIGHT_RESULT ok");
} catch (error) {
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  await dumpState("FAILURE");
  console.error("PLAYWRIGHT_RESULT failed");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
