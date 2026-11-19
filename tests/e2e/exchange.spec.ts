import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const port = process.env.SANTA_LOCAL_PORT ?? "5197";
const origin = `http://127.0.0.1:${port}`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2xkAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ request }) => {
  // Keep the loopback sign-in quota independent across test cases.
  const database = "00000000-0000-4000-8000-000000000001";
  const response = await request.post(`/cdn-cgi/local/explorer/api/d1/database/${database}/raw`, {
    data: { sql: "DELETE FROM auth_rate_limits" },
  });
  await expect(response).toBeOK();
});

async function signIn(page: Page, url: string, email: string) {
  await page.goto(url);
  await page.getByRole("textbox", { name: "Email address" }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  let otp: string | undefined;
  await expect.poll(async () => {
    const output = await readFile(`.cloudflare/e2e-mail-${port}.log`, "utf8");
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

test("a Draw Party counts down and unlocks the private match for live and late arrivals", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const organizerName = "Draw Party Host";
  await signIn(page, "/", `party-host-${randomUUID()}@example.test`);
  await page.getByLabel("Group name").fill("Holiday Draw");
  await page.getByLabel("Your display name").fill(organizerName);
  await page.getByRole("button", { name: "Create group" }).click();
  const invite = await page.getByLabel("Invitation link").inputValue();
  await addressAndWish(page, "Host");
  const privatePhoto = await page.locator("#wish-list img").getAttribute("src");
  expect(privatePhoto).toBeTruthy();

  const context = await browser.newContext({ baseURL: origin });
  try {
    const guest = await context.newPage();
    const pageErrors: string[] = [];
    guest.on("pageerror", error => pageErrors.push(error.message));
    await signIn(guest, invite, `party-guest-${randomUUID()}@example.test`);
    await guest.getByLabel("Your display name").fill("Party Guest");
    await guest.getByRole("button", { name: "Join group" }).click();
    await expect(guest).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);
    await page.reload();

    const releaseField = page.getByLabel("Draw Party release time");
    await expect(releaseField).toBeVisible();
    const releaseAt = Math.ceil((Date.now() + 20_000) / 60_000) * 60_000;
    const localTime = await page.evaluate((timestamp) => {
      const date = new Date(timestamp);
      return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    }, releaseAt);
    await releaseField.fill(localTime);
    await page.getByRole("button", { name: "Draw names", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Draw Party" })).toBeVisible();

    await guest.bringToFront();
    const match = guest.locator("#recipient");
    const timer = match.getByRole("timer");
    await expect(match.getByRole("heading", { name: "Draw Party" })).toBeVisible({ timeout: 12_000 });
    await expect(match.locator("time")).toHaveAttribute("datetime", new Date(releaseAt).toISOString());
    await expect(timer).toBeVisible();
    const firstTick = await timer.textContent();
    await expect(match.getByText("Unwrap match", { exact: true })).toHaveCount(0);
    const html = await (await guest.request.get(guest.url())).text();
    for (const detail of [organizerName, "100 Host Lane", "Host wish", privatePhoto!]) expect(html).not.toContain(detail);
    expect((await guest.request.get(privatePhoto!)).status()).toBe(404);
    await expect.poll(() => timer.textContent(), { timeout: 5000 }).not.toBe(firstTick);
    expect(pageErrors).toEqual([]);

    const littleOnes = guest.locator("#little-ones");
    await littleOnes.getByText("Add a child", { exact: true }).click();
    await littleOnes.getByLabel("Display name", { exact: true }).fill(" ");
    await littleOnes.getByLabel("Age", { exact: true }).fill("6");
    let finishPost!: () => void;
    const holdPost = new Promise<void>(resolve => { finishPost = resolve; });
    await guest.route(url => url.pathname.endsWith(".data"), async route => {
      if (route.request().method() === "POST") await holdPost;
      await route.continue();
    });
    try {
      // Let the countdown expire while a form submission is waiting to fail.
      await littleOnes.getByRole("button", { name: "Add child", exact: true }).click();
      await expect(littleOnes.getByRole("button", { name: "Add child", exact: true })).toBeDisabled();
      await expect(timer).toHaveText("0h 0m 0s", { timeout: 85_000 });
    } finally {
      finishPost();
    }
    await expect(guest.getByRole("alert")).toHaveText("Fill in the required fields.");
    await expect(match.getByText("Unwrap match", { exact: true })).toBeVisible();
    await expect(match.locator(".recipient-name")).toBeHidden();
    await match.getByText("Unwrap match", { exact: true }).click();
    await expect(match.locator(".recipient-name")).toHaveText(organizerName);
    await expect(match.locator("address")).toContainText("100 Host Lane");
    await expect(match.getByText("Host wish", { exact: true })).toBeVisible();
    expect((await guest.request.get(privatePhoto!)).status()).toBe(200);

    const late = await context.newPage();
    await late.goto(guest.url());
    await expect(late.getByRole("timer")).toHaveCount(0);
    await late.getByText("Unwrap match", { exact: true }).click();
    await expect(late.locator(".recipient-name")).toHaveText(organizerName);
  } finally {
    await context.close();
  }
});

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

test("one account can organize one group and join another", async ({ page, browser }) => {
  const email = `multi-${randomUUID()}@example.test`;
  await signIn(page, "/", email);
  await page.getByLabel("Group name").fill("Family exchange");
  await page.getByLabel("Your display name").fill("Family organizer");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByRole("heading", { name: "Organizer tools" })).toBeVisible();
  const family = page.url();
  const familyMember = await page.locator('input[name="actingMembershipId"]').first().inputValue();
  await addressAndWish(page, "Family");

  const context = await browser.newContext({ baseURL: origin });
  try {
    const friend = await context.newPage();
    await signIn(friend, "/", `friend-${randomUUID()}@example.test`);
    await friend.getByLabel("Group name").fill("Friends exchange");
    await friend.getByLabel("Your display name").fill("Friends organizer");
    await friend.getByRole("button", { name: "Create group" }).click();
    const invite = await friend.getByLabel("Invitation link").inputValue();
    const privatePhoto = await page.locator("#wish-list img").getAttribute("src");
    expect((await friend.request.get(family)).status()).toBe(404);
    expect((await friend.request.get(privatePhoto!)).status()).toBe(404);

    await page.goto(invite);
    await page.getByLabel("Your display name").fill("Friend");
    await page.getByRole("button", { name: "Join group" }).click();
    await expect(page.getByRole("heading", { name: "Friends exchange" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organizer tools" })).toHaveCount(0);
    await expect(page.locator("#wish-list").getByText("Family wish")).toHaveCount(0);
    const friends = page.url();
    expect(friends).not.toBe(family);
    const friendMember = await page.locator('input[name="actingMembershipId"]').first().inputValue();
    const denied = await page.request.post(friends, {
      headers: { Origin: origin },
      form: { intent: "delete-group", actingMembershipId: friendMember, groupId: new URL(friends).pathname.split("/").at(-1)!, confirm: "yes" },
    });
    expect(denied.status()).toBe(400);
    const stale = await page.request.post(friends, {
      headers: { Origin: origin },
      form: { intent: "add-child", actingMembershipId: familyMember, name: "Wrong group", age: "8" },
    });
    expect(stale.status()).toBe(409);
    await page.goto(invite);
    await expect(page).toHaveURL(friends);

    await page.getByRole("link", { name: "My exchanges" }).click();
    await expect(page.getByRole("link", { name: "Friends exchange Member" })).toBeVisible();
    await page.getByRole("link", { name: "Family exchange" }).click();
    await expect(page).toHaveURL(family);
    await expect(page.getByRole("heading", { name: "Organizer tools" })).toBeVisible();
    await expect(page.locator("#wish-list").getByText("Family wish")).toBeVisible();

    await page.getByRole("link", { name: "My exchanges" }).click();
    await page.getByRole("link", { name: "Create an exchange" }).click();
    await page.getByLabel("Group name").fill("Office exchange");
    await page.getByLabel("Your display name").fill("Office organizer");
    await page.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByRole("heading", { name: "Office exchange" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organizer tools" })).toBeVisible();
  } finally {
    await context.close();
  }
});

function submittedFields(button: Locator) {
  return button.evaluate(element =>
    Object.fromEntries(Array.from(new FormData((element as HTMLButtonElement).form!), ([key, value]) => [key, String(value)])));
}

test("codename mode keeps identities private while matches exchange Elf Mail", async ({ page, browser }) => {
  const organizerName = "Real Organizer Name";
  const guestName = "Real Guest Name";
  await signIn(page, "/", `codename-host-${randomUUID()}@example.test`);
  await page.getByLabel("Group name").fill("Secret Identities");
  await page.getByLabel("Your display name").fill(organizerName);
  await page.getByRole("button", { name: "Create group" }).click();
  const invite = await page.getByLabel("Invitation link").inputValue();
  const organizerId = await page.locator('input[name="actingMembershipId"]').first().inputValue();
  await addressAndWish(page, "Hidden");

  const context = await browser.newContext({ baseURL: origin });
  try {
    const guest = await context.newPage();
    await signIn(guest, invite, `codename-guest-${randomUUID()}@example.test`);
    await guest.setViewportSize({ width: 320, height: 780 });
    await guest.getByLabel("Your display name").fill(guestName);
    await guest.getByRole("button", { name: "Join group" }).click();
    await expect(guest).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);
    await expect(guest.getByRole("heading", { name: "Elf Mail inbox" })).toHaveCount(0);

    await page.reload();
    await page.getByRole("button", { name: "Enable codename mode" }).click();
    await expect(page.getByRole("button", { name: "Disable codename mode" })).toBeVisible();
    const releaseTime = await page.evaluate(() => {
      const future = new Date(Date.now() + 60 * 60_000);
      return new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    const releaseField = page.getByLabel("Draw Party release time");
    await releaseField.fill(releaseTime);
    await page.getByRole("button", { name: "Draw names", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Draw Party", exact: true })).toBeVisible();
    const redraw = page.getByRole("button", { name: "Redraw names", exact: true });
    const pendingDraw = await submittedFields(redraw);
    const earlyMessage = await page.request.post(page.url(), {
      headers: { Origin: origin },
      form: { ...pendingDraw, intent: "elf-mail-question", body: "A question before the draw opens." },
    });
    expect(earlyMessage.status()).toBe(409);
    await guest.reload();
    await expect(guest.getByRole("heading", { name: "Elf Mail inbox" })).toHaveCount(0);

    await releaseField.fill("");
    await page.getByLabel("I understand everyone’s recipient can change.").check();
    await redraw.click();
    await expect(page.getByText("Draw published. Notifications are queued.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disable codename mode" })).toHaveCount(0);

    await guest.reload();
    const match = guest.locator("#recipient");
    await match.getByText("Unwrap match", { exact: true }).click();
    const alias = await match.locator(".recipient-name").innerText();
    expect(alias).toBeTruthy();
    expect(alias).not.toBe(organizerName);
    await expect(page.getByText("Your codename is", { exact: false })).toContainText(alias);
    await expect(match.getByText("Hidden wish", { exact: true })).toBeVisible();
    await expect(match.locator("address")).toHaveCount(0);
    const html = await (await guest.request.get(guest.url())).text();
    for (const identity of [organizerName, organizerId, "100 Hidden Lane"]) expect(html).not.toContain(identity);

    await guest.reload();
    await match.getByText("Unwrap match", { exact: true }).click();
    await expect(match.locator(".recipient-name")).toHaveText(alias);

    const question = "What snack would you hide from the rest of the house?";
    const reply = "Chocolate-covered pretzels.";
    const outgoing = match.getByRole("region", { name: "Elf Mail" });
    const sent = outgoing.getByRole("list", { name: "Messages" });
    await outgoing.getByText("Ask a question", { exact: true }).click();
    await outgoing.getByRole("radio", { name: question, exact: true }).check();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await outgoing.getByRole("button", { name: "Send prompt" }).click();
    await expect(sent.getByText(question, { exact: true })).toBeVisible();

    await page.reload();
    await page.getByRole("link", { name: "Elf Mail", exact: true }).click();
    const inbox = page.getByRole("region", { name: "Elf Mail inbox" });
    await expect(inbox.getByText(question, { exact: true })).toBeVisible();
    await expect(inbox.getByText("Your Secret Santa", { exact: true })).toBeVisible();
    await expect(inbox).not.toContainText(guestName);
    await inbox.getByLabel("Your reply").fill(reply);
    const replyButton = inbox.getByRole("button", { name: "Send reply" });
    const previousReply = await submittedFields(replyButton);
    await replyButton.click();
    await expect(inbox.getByText(reply, { exact: true })).toBeVisible();

    await guest.reload();
    await match.getByText("Unwrap match", { exact: true }).click();
    await expect(sent.getByText(reply, { exact: true })).toBeVisible();
    await expect(sent.getByText(alias, { exact: true })).toBeVisible();
    const repliedHtml = await (await guest.request.get(guest.url())).text();
    for (const identity of [organizerName, organizerId]) expect(repliedHtml).not.toContain(identity);

    await page.getByLabel("I understand everyone’s recipient can change.").check();
    await page.getByRole("button", { name: "Redraw names", exact: true }).click();
    await expect(page.getByText("Draw published. Notifications are queued.", { exact: true })).toBeVisible();
    const staleReply = await page.request.post(new URL(page.url()).pathname, {
      headers: { Origin: origin },
      form: { ...previousReply, requestId: randomUUID(), body: "Reply from the previous draw." },
    });
    expect(staleReply.status()).toBe(409);
    await expect(inbox.getByText(question, { exact: true })).toHaveCount(0);

    await outgoing.getByText("Ask a question", { exact: true }).click();
    await outgoing.getByLabel("Your question").fill("Question from the previous draw.");
    await outgoing.getByRole("button", { name: "Send question" }).click();
    await expect(guest.getByRole("alert")).toContainText("This Elf Mail conversation is unavailable.");
    await match.getByText("Unwrap match", { exact: true }).click();
    await expect(outgoing.getByRole("list", { name: "Messages" })).toHaveCount(0);
    const nextQuestion = "What color would you pick?";
    await outgoing.getByText("Ask a question", { exact: true }).click();
    await outgoing.getByRole("radio", { name: nextQuestion, exact: true }).check();
    await outgoing.getByRole("button", { name: "Send prompt" }).click();
    await expect(sent.getByText(nextQuestion, { exact: true })).toBeVisible();
    await page.reload();
    await expect(inbox.getByText(nextQuestion, { exact: true })).toBeVisible();
    await expect(inbox.getByText(reply, { exact: true })).toHaveCount(0);
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
  await expect(page).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);
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
      await expect(participant).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);
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
    const stale = await bailey.request.post(bailey.url(), {
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

    const [giverName, recipientName] = [...first.pairs].find(([giver, recipient]) => giver !== "Alex" && recipient !== "Alex")!;
    const giver = pages.get(giverName)!;
    const recipient = pages.get(recipientName)!;
    const outgoing = giver.locator("#recipient").getByRole("region", { name: "Elf Mail" });
    const customQuestion = "Would you use a pocket-sized constellation map?";
    await outgoing.getByText("Ask a question", { exact: true }).click();
    await outgoing.getByLabel("Your question").fill(customQuestion);
    const sendQuestion = outgoing.getByRole("button", { name: "Send question" });
    const originalSubmission = await submittedFields(sendQuestion);
    await sendQuestion.click();
    await expect(outgoing.getByRole("list", { name: "Messages" }).getByText(customQuestion, { exact: true })).toBeVisible();
    const duplicate = await giver.request.post(giver.url(), { headers: { Origin: origin }, form: originalSubmission });
    expect(duplicate.status()).toBe(200);

    const firstLine = "What is your favorite winter activity?";
    const secondLine = "x".repeat(499 - firstLine.length);
    const multiline = await giver.request.post(giver.url(), {
      headers: { Origin: origin },
      form: { ...originalSubmission, requestId: randomUUID(), body: `${firstLine}\r\n${secondLine}` },
    });
    expect(multiline.status()).toBe(200);
    const invalidMessage = await giver.request.post(giver.url(), {
      headers: { Origin: origin },
      form: { ...originalSubmission, requestId: randomUUID(), body: "\0Invalid message." },
    });
    expect(invalidMessage.status()).toBe(400);

    await recipient.reload();
    const inbox = recipient.getByRole("region", { name: "Elf Mail inbox" });
    const deliveredQuestion = inbox.getByRole("listitem").filter({ hasText: customQuestion });
    await expect(deliveredQuestion).toHaveCount(1);
    await expect(deliveredQuestion.getByText("Your Secret Santa", { exact: true })).toBeVisible();
    await expect(inbox.getByText(firstLine)).toBeVisible();
    await expect(inbox).not.toContainText(giverName);
    expect(await (await recipient.request.get(recipient.url())).text()).not.toContain(originalSubmission.actingMembershipId);
    for (const [name, participant] of pages) {
      if (name === giverName || name === recipientName) continue;
      expect(await (await participant.request.get(participant.url())).text()).not.toContain(customQuestion);
    }
    const signedOut = await outsider.request.get(giver.url(), { maxRedirects: 0 });
    expect(signedOut.status()).toBe(302);
    const foreignSubmission = await page.request.post(page.url(), {
      headers: { Origin: origin },
      form: { ...originalSubmission, body: "A question from a different account." },
    });
    expect(foreignSubmission.status()).toBe(409);
    const unsolicitedReply = await page.request.post(page.url(), {
      headers: { Origin: origin },
      form: { ...originalSubmission, intent: "elf-mail-reply", actingMembershipId, body: "A reply without a question." },
    });
    expect(unsolicitedReply.status()).toBe(409);

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
    for (const participant of [giver, recipient]) {
      expect(await (await participant.request.get(participant.url())).text()).not.toContain(customQuestion);
    }

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
