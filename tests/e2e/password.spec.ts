import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

async function createAccount(page: Page, email: string, password: string) {
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Create your Secret Santa account" })).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

test("password accounts can merge while email delivery is disabled", async ({ page, browser, baseURL }) => {
  const primary = `primary-${randomUUID()}@example.test`;
  const other = `other-${randomUUID()}@example.test`;
  const password = "a password used only for tests";
  await page.goto("/");
  await createAccount(page, primary, password);
  await page.getByRole("link", { name: "Account settings" }).click();

  const context = await browser.newContext({ baseURL });
  try {
    const otherPage = await context.newPage();
    await otherPage.goto("/");
    await createAccount(otherPage, other, password);
    await otherPage.getByLabel("Group name").fill("Family exchange");
    await otherPage.getByLabel("Your display name").fill("Jessie");
    await otherPage.getByRole("button", { name: "Create group" }).click();
    await expect(otherPage).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);

    await page.getByRole("link", { name: "Merge accounts" }).click();
    await page.getByLabel("Other email address").fill(other);
    await page.getByLabel("Other account’s password").fill(password);
    await page.getByRole("button", { name: "Confirm merge" }).click();
    await expect(page.getByRole("status")).toHaveText("Accounts merged.");
    await page.getByRole("link", { name: "My exchanges" }).click();
    await page.getByRole("link", { name: "Family exchange Organizer" }).click();
    await expect(page).toHaveURL(otherPage.url());
  } finally {
    await context.close();
  }
});

test("password accounts can create and join an exchange without email", async ({ page, browser }) => {
  const email = `organizer-${randomUUID()}@example.test`;
  const password = "a password used only for tests";
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Send sign-in code" })).toHaveCount(0);
  await createAccount(page, email, password);
  await page.getByLabel("Group name").fill("Password Gift Exchange");
  await page.getByLabel("Your display name").fill("Organizer");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);
  const invite = await page.getByLabel("Invitation link").inputValue();
  await expect(page.getByText("Email an invitation")).toHaveCount(0);

  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(invite);
    await createAccount(guest, `guest-${randomUUID()}@example.test`, password);
    await guest.getByLabel("Your display name").fill("Guest");
    await guest.getByRole("button", { name: "Join group" }).click();
    await expect(guest).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);
    await page.reload();
    await page.getByRole("button", { name: "Draw names", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Everyone can sign in to see their match." })).toBeVisible();
    await guest.reload();
    await guest.getByText("Unwrap match", { exact: true }).click();
    await expect(guest.locator(".recipient-name")).toHaveText("Organizer");
  } finally {
    await context.close();
  }

  const dashboard = page.url();
  const account = page.getByRole("banner").getByRole("navigation", { name: "Account" });
  await account.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${new URL(dashboard).origin}/`);
  await expect(account).toHaveCount(0);
  await page.goto(dashboard);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill("a different password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Email address or password is incorrect.");
  await expect(page.getByLabel("Password")).toHaveValue("");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/exchange\/[a-f0-9-]{36}$/);
});
