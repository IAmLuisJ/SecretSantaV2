import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:5197";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2xkAAAAASUVORK5CYII=",
  "base64",
);

async function signIn(page: Page, url: string, email: string) {
  await page.goto(url);
  await page.getByRole("textbox", { name: "Email address" }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  let otp: string | undefined;
  await expect.poll(async () => {
    const output = await readFile(".cloudflare/e2e-mail.log", "utf8");
    const marker = `to: '${email}'`;
    const message = output.includes(marker) ? output.split(marker).at(-1)?.split("[local mail]")[0] : undefined;
    otp = message?.match(/sign-in code is (\d{6})/)?.[1];
    return otp;
  }).toMatch(/^\d{6}$/);
  await page.getByLabel("Sign-in code").fill(otp!);
  await page.getByRole("button", { name: "Verify code" }).click();
}

async function addressAndWish(page: Page, name: string) {
  await page.getByText("Add a mailing address", { exact: true }).click();
  await page.getByLabel("First name").fill(name);
  await page.getByLabel("Last name").fill("Example");
  await page.getByLabel("Street address").fill(`100 ${name} Lane`);
  await page.getByLabel("City").fill("Detroit");
  await page.getByLabel("State or region").fill("MI");
  await page.getByLabel("ZIP or postal code").fill("48201");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("Address saved.", { exact: true })).toBeVisible();
  const wishes = page.locator("#wish-list");
  await wishes.getByText("Add a wish", { exact: true }).click();
  await wishes.getByLabel("Item name").fill(`${name} wish`);
  await wishes.getByLabel("Product link").fill("example.com/gift");
  await wishes.locator('input[type="file"]').setInputFiles({ name: "wish.png", mimeType: "image/png", buffer: png });
  await wishes.getByRole("button", { name: "Add wish" }).click();
  await expect(wishes.getByText(`${name} wish`, { exact: true })).toBeVisible();
}

test("native forms verify email and create a group before JavaScript loads", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await signIn(page, "/", `native-${randomUUID()}@example.test`);
    await page.getByLabel("Group name").fill("Native form group");
    await page.getByLabel("Your display name").fill("No JavaScript");
    await page.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByRole("heading", { name: "Native form group" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a mobile group runs two private annual exchanges and shares Little Ones gifts", async ({ page, browser }) => {
  const slug = randomUUID().slice(0, 8);
  const email = (name: string) => `${name.toLowerCase()}-${slug}@example.test`;
  const people = ["Alex", "Bailey", "Casey", "Drew"];
  const pages = new Map<string, Page>([["Alex", page]]);
  await signIn(page, "/", email("Alex"));
  await page.getByLabel("Group name").fill("Winter Friends");
  await page.getByLabel("First exchange year").fill("2026");
  await page.getByLabel("Your display name").fill("Alex");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page).toHaveURL(/\/exchange$/);
  const invite = await page.getByLabel("Invitation link").inputValue();
  expect(invite).toMatch(/\/join\?code=/);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText(/Invitation link copied|The link is selected/)).toBeVisible();

  const contexts = [];
  try {
    for (const name of people.slice(1)) {
      const context = await browser.newContext({ baseURL: origin, viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
      contexts.push(context);
      const participant = await context.newPage();
      pages.set(name, participant);
      await signIn(participant, invite, email(name));
      await participant.getByLabel("Your display name").fill(name);
      await participant.getByRole("button", { name: "Join group" }).click();
      await expect(participant).toHaveURL(/\/exchange$/);
      await expect(participant.getByRole("heading", { name: "Organizer tools" })).toHaveCount(0);
    }

    for (const [name, participant] of pages) await addressAndWish(participant, name);

    await page.getByText("Add a child", { exact: true }).click();
    await page.getByLabel("Display name", { exact: true }).fill("Robin");
    await page.getByLabel("Age", { exact: true }).fill("6");
    await page.getByRole("button", { name: "Add child", exact: true }).click();
    const child = page.locator("#little-ones").locator(".child");
    await child.getByText("Add a wish", { exact: true }).click();
    await child.getByLabel("Item name").fill("Train set");
    await child.getByRole("button", { name: "Add wish" }).click();
    await expect(child.getByText("Train set", { exact: true })).toBeVisible();
    const bailey = pages.get("Bailey")!;
    await bailey.reload();
    const actingMembershipId = await page.locator('input[name="actingMembershipId"]').first().inputValue();
    const stale = await bailey.request.post("/exchange", {
      headers: { Origin: origin },
      form: { intent: "add-child", actingMembershipId, name: "Stale child", age: "8" },
    });
    expect(stale.status()).toBe(409);
    await bailey.getByRole("button", { name: "Mark as purchased" }).click();
    await expect(bailey.getByRole("button", { name: "Mark as unpurchased" })).toBeVisible();
    await bailey.getByRole("button", { name: "Mark as unpurchased" }).click();
    await expect(bailey.getByRole("button", { name: "Mark as purchased" })).toBeVisible();

    await page.reload();
    await page.getByText("Block a pair", { exact: true }).click();
    await page.getByLabel("First adult").selectOption({ label: "Alex" });
    await page.getByLabel("Second adult").selectOption({ label: "Bailey" });
    await page.getByRole("button", { name: "Save exclusion" }).click();
    await expect(page.getByRole("button", { name: "Remove exclusion" })).toBeVisible();

    const readDraw = async () => {
      const pairs = new Map<string, string>();
      const photoPaths = new Map<string, string>();
      for (const [giver, participant] of pages) {
        await participant.reload();
        const recipient = participant.locator("#recipient");
        await expect(recipient.locator(".recipient-name")).toBeHidden();
        await expect(recipient.locator("address")).toBeHidden();
        await recipient.getByText("Unwrap match", { exact: true }).click();
        const name = await recipient.locator(".recipient-name").innerText();
        expect(name).not.toBe(giver);
        if (giver === "Alex" || giver === "Bailey") expect(["Casey", "Drew"]).toContain(name);
        await expect(recipient.locator("address")).toContainText(`100 ${name} Lane`);
        await expect(recipient.getByText(`${name} wish`, { exact: true })).toBeVisible();
        const photo = await recipient.locator("img").getAttribute("src");
        expect((await participant.request.get(photo!)).status()).toBe(200);
        if (giver === "Alex") {
          await recipient.getByText("Hide match", { exact: true }).click();
          await expect(recipient.locator(".recipient-name")).toBeHidden();
          await expect(recipient.locator("address")).toBeHidden();
        }
        pairs.set(giver, name);
        photoPaths.set(giver, photo!);
      }
      expect(new Set(pairs.values()).size).toBe(4);
      return { pairs, photoPaths };
    };

    await page.getByRole("button", { name: "Draw names", exact: true }).click();
    await expect(page.getByRole("button", { name: "Redraw names" })).toBeVisible();
    const first = await readDraw();
    const outsider = await browser.newContext({ baseURL: origin });
    contexts.push(outsider);
    expect((await outsider.request.get(first.photoPaths.get("Alex")!)).status()).toBe(404);

    await page.getByText("Complete this exchange", { exact: true }).click();
    await page.getByLabel("Finish the exchange with the currently published draw.").check();
    await page.getByRole("button", { name: "Complete exchange", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start exchange" })).toBeVisible();
    await page.getByLabel("Exchange year", { exact: true }).fill("2028");
    await page.getByRole("button", { name: "Start exchange" }).click();
    await expect(page.getByRole("button", { name: "Draw names", exact: true })).toBeVisible();
    expect((await page.request.get(first.photoPaths.get("Alex")!)).status()).toBe(404);
    await page.getByRole("button", { name: "Draw names", exact: true }).click();
    await expect(page.getByRole("button", { name: "Redraw names" })).toBeVisible();
    const second = await readDraw();
    for (const [giver, recipient] of second.pairs) expect(recipient).not.toBe(first.pairs.get(giver));

    await page.setViewportSize({ width: 320, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.locator("summary").filter({ hasText: /^Delete group$/ }).click();
    await page.getByLabel("Delete this group and its exchange data.").check();
    await page.getByRole("button", { name: "Delete group", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create an exchange" })).toBeVisible();
    expect((await bailey.request.get(second.photoPaths.get("Bailey")!)).status()).toBe(404);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
