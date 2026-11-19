import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
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

test("codename mode hides the match's identity but keeps their wish list", async ({ page, browser }) => {
  const organizerName = "Real Organizer Name";
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
    await guest.getByLabel("Your display name").fill("Guest");
    await guest.getByRole("button", { name: "Join group" }).click();
    await expect(guest).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);

    await page.reload();
    await page.getByRole("button", { name: "Enable codename mode" }).click();
    await expect(page.getByRole("button", { name: "Disable codename mode" })).toBeVisible();
    await page.getByRole("button", { name: "Draw names", exact: true }).click();
    await expect(page.getByRole("button", { name: "Redraw names", exact: true })).toBeVisible();
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
  } finally {
    await context.close();
  }
});

test("Guess Your Santa keeps a participant’s guess private until the organizer reveals real pairings", async ({ page, browser }) => {
  await signIn(page, "/", `santa-guess-host-${randomUUID()}@example.test`);
  await page.getByLabel("Group name").fill("Guessing game");
  await page.getByLabel("Your display name").fill("Riley Organizer");
  await page.getByRole("button", { name: "Create group" }).click();
  const invite = await page.getByLabel("Invitation link").inputValue();

  const context = await browser.newContext({ baseURL: origin });
  try {
    const guest = await context.newPage();
    await signIn(guest, invite, `santa-guess-guest-${randomUUID()}@example.test`);
    await guest.getByLabel("Your display name").fill("Jordan Participant");
    await guest.getByRole("button", { name: "Join group" }).click();
    await expect(guest).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);

    await page.reload();
    await page.getByRole("button", { name: "Enable codename mode" }).click();
    await expect(page.getByRole("button", { name: "Disable codename mode" })).toBeVisible();
    await expect(page.getByText(/real names.*even when the draw uses codenames/i)).toBeVisible();
    await page.getByRole("checkbox", { name: /I understand the reveal shares real names/i }).check();
    await page.getByRole("button", { name: "Enable Guess Your Santa" }).click();
    await expect(page.getByText(/Guess Your Santa is on/i)).toBeVisible();
    await page.getByRole("button", { name: "Draw names", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reveal Santas", exact: true })).toBeVisible();

    await guest.reload();
    const game = guest.locator("#guess-your-santa");
    await expect(game.getByRole("heading", { name: "Guess Your Santa" })).toBeVisible();
    await expect(game.getByRole("table")).toHaveCount(0);
    const staleGuest = await context.newPage();
    await staleGuest.goto(guest.url());
    const staleGame = staleGuest.locator("#guess-your-santa");
    await staleGame.getByLabel("Who gave you your gift?").selectOption({ label: "Riley Organizer" });
    await staleGame.getByRole("checkbox", { name: /I’ve opened my gift/ }).check();

    await game.getByLabel("Who gave you your gift?").selectOption({ label: "Riley Organizer" });
    await game.getByRole("checkbox", { name: /I’ve opened my gift/ }).check();
    await game.getByRole("button", { name: "Lock in my guess" }).click();
    await expect(game.getByText(/Guess locked/)).toContainText("Riley Organizer");
    await guest.reload();
    await expect(game.getByText(/Guess locked/)).toContainText("Riley Organizer");
    await expect(game.getByRole("button", { name: "Lock in my guess" })).toHaveCount(0);
    const privatePage = await (await guest.request.get(guest.url())).text();
    expect(privatePage).not.toContain("giverName");
    expect(privatePage).not.toContain("guessCorrect");

    await page.reload();
    await expect(page.locator("#guess-your-santa").getByRole("button", { name: "Lock in my guess" })).toBeVisible();
    await expect(page.locator("#guess-your-santa").getByRole("table")).toHaveCount(0);
    await page.getByRole("checkbox", { name: /Share the real names and close guessing/ }).check();
    await page.getByRole("button", { name: "Reveal Santas", exact: true }).click();
    await expect(page.getByRole("table", { name: /Secret Santa pairings/ })).toBeVisible();

    await guest.reload();
    const pairings = game.getByRole("table", { name: /Secret Santa pairings/ });
    await expect(pairings.getByRole("row", { name: "Riley Organizer Jordan Participant Correct" })).toBeVisible();
    await expect(pairings.getByRole("row", { name: "Jordan Participant Riley Organizer No guess" })).toBeVisible();

    await staleGame.getByRole("button", { name: "Lock in my guess" }).click();
    await expect(staleGuest.getByRole("alert")).toBeVisible();
    await expect(staleGame.getByRole("table", { name: /Secret Santa pairings/ })).toBeVisible();
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
