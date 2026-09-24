import { expect, test } from "@playwright/test";

test("photo note is private, needs no point or email, and can be resolved and reopened", async ({ page }) => {
  const catalog = await (await page.request.get("/data/photos.geojson")).json();
  const xid = catalog.features[0].properties.id;
  const beforeState = await (await page.request.get("/api/review-state?snapshot=1")).json();
  await page.goto(`/?xid=${encodeURIComponent(xid)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#archive-modal")).toHaveClass(/is-open/);
  await page.locator("#photo-feedback-cta").click();
  await expect(page.locator("#modal-photo-feedback-view")).toBeVisible();
  await expect(page.locator("#photo-feedback-form button[type=submit]")).toBeDisabled();
  await page.locator("#photo-feedback-message").fill("Popis obsahuje <script>alert(1)</script> a nesedí s archivem.");
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/feedback") && response.request().method() === "POST");
  await page.locator("#photo-feedback-form button[type=submit]").click();
  const response = await sent;
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt.id).toMatch(/^\d+$/u);
  const sentBody = response.request().postDataJSON();
  const repeated = await page.request.post("/api/feedback", { data: sentBody });
  expect((await repeated.json()).id).toBe(receipt.id);
  expect((await page.request.post("/api/feedback", {
    data: { ...sentBody, message: "Jiná poznámka se stejným ID." },
  })).status()).toBe(409);
  const afterState = await (await page.request.get("/api/review-state?snapshot=1")).json();
  expect(afterState.groupCorrections).toEqual(beforeState.groupCorrections);
  await expect(page.locator("#photo-feedback-status")).toContainText("Děkujeme");
  await expect(page.locator("#photo-feedback-form button[type=submit]")).toBeDisabled();

  await page.goto("/admin.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#feedback-admin-list")).toContainText(xid);
  const card = page.locator(".feedback-admin-item").filter({ hasText: xid }).first();
  await expect(card).toContainText("<script>alert(1)</script>");
  expect(await card.locator("script").count()).toBe(0);
  await card.getByRole("button", { name: "Označit jako vyřízené" }).click();
  await page.locator("#feedback-resolved").click();
  const resolved = page.locator(".feedback-admin-item").filter({ hasText: xid }).first();
  await expect(resolved).toBeVisible();
  await resolved.getByRole("button", { name: "Vrátit mezi nové" }).click();
  await page.locator("#feedback-new").click();
  await expect(page.locator(".feedback-admin-item").filter({ hasText: xid }).first()).toBeVisible();
  const finalState = await (await page.request.get("/api/review-state?snapshot=1")).json();
  expect(finalState.groupCorrections).toEqual(beforeState.groupCorrections);
});

test("feedback form keeps the text after an unavailable API and restores focus", async ({ page }) => {
  const catalog = await (await page.request.get("/data/photos.geojson")).json();
  const xid = catalog.features[1].properties.id;
  await page.route("**/api/feedback", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"Dočasně nedostupné"}' }));
  await page.goto(`/?xid=${encodeURIComponent(xid)}`, { waitUntil: "domcontentloaded" });
  const opener = page.locator("#photo-feedback-cta");
  await opener.click();
  await expect(page.locator("#photo-feedback-message")).toBeFocused();
  await page.locator("#photo-feedback-message").fill("Tato fotografie má chybný popis.");
  await page.locator("#photo-feedback-form button[type=submit]").click();
  await expect(page.locator("#photo-feedback-status")).toContainText("Dočasně nedostupné");
  await expect(page.locator("#photo-feedback-message")).toHaveValue("Tato fotografie má chybný popis.");
  await page.locator("#cancel-photo-feedback").click();
  await expect(opener).toBeFocused();
});
