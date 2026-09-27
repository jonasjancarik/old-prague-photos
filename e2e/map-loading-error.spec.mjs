import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`community API failure shows a useful error and retry recovers at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/review-state?**", (route) => route.fulfill({
      status: 503,
      json: { detail: "Katalog fotografií není dočasně dostupný" },
    }));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const error = page.locator("#map-load-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toContainText("Fotografie se teď nedaří načíst");
    await expect(error).not.toContainText("503");
    await expect(page.locator(".map-toolbar")).toBeHidden();
    await expect(page.locator(".photo-grid-section")).toBeHidden();
    await expect(page.locator(".map-overlay")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/davnapraha-map-error-${viewport.width}.png` });

    await page.unroute("**/api/review-state?**");
    const retry = page.getByRole("button", { name: "Zkusit znovu" });
    await retry.focus();
    await retry.press("Enter");
    await expect(page.locator("#map-search")).toBeEnabled({ timeout: 30_000 });
    await expect(error).toBeHidden();
    await expect(page.locator("#photo-count")).not.toHaveText("—");
    await expect(page.locator("#map")).toBeVisible();
    await expect(page.locator(".photo-grid-section")).toBeVisible();
  });
}

test("catalog network failure and unavailable fallback show the same map error", async ({ page }) => {
  await page.route("**/data/photos.geojson", (route) => route.abort("failed"));
  await page.route("**/api/photos", (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert")).toContainText("Fotografie se teď nedaří načíst");
  await expect(page.getByRole("button", { name: "Zkusit znovu" })).toBeVisible();
  await expect(page.locator(".photo-grid-section")).toBeHidden();
});
