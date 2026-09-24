import { expect, test } from "@playwright/test";

test("author sees receipt and both points; another browser can confirm", async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pomoc.html?mode=location", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#vote-down")).toBeEnabled();
  await expect(page.locator("#current-xid")).not.toHaveText("—");
  const groupId = await page.locator("#current-xid").getAttribute("title");
  await page.locator("#vote-down").click();
  await expect(page.locator("#submit-correction")).toBeDisabled();
  await expect(page.locator("#help-selection-hint")).toBeVisible();
  const map = page.locator("#help-map");
  await map.scrollIntoViewIfNeeded();
  const mapBox = await map.boundingBox();
  await map.click({ position: { x: mapBox.width * .63, y: mapBox.height * .38 } });
  await expect(page.locator("#submit-correction")).toBeEnabled();
  const receiptWait = page.waitForResponse((response) => response.url().endsWith("/api/corrections") && response.request().method() === "POST");
  await page.locator("#submit-correction").click();
  const correctionResponse = await receiptWait;
  const xid = correctionResponse.request().postDataJSON().xid;
  const receipt = await correctionResponse.json();
  expect(receipt.correction_id).toMatch(/^\d+$/u);
  const stored = await (await page.request.get("/api/review-state?snapshot=1")).json();
  const storedProposal = stored.groupCorrections.find((row) => row.group_id === receipt.accepted_group_id);
  expect(String(storedProposal.proposed_id)).toBe(receipt.correction_id);
  await expect(page.locator("#form-status")).toContainText("Čeká na potvrzení dalšího člověka");
  await expect(page.locator("#current-xid")).not.toHaveAttribute("title", groupId);
  await expect(page.locator("#form-status")).toContainText("Čeká na potvrzení dalšího člověka");
  const own = await page.evaluate(({ xid, id }) => window.OldPragueOwnProposals.isCurrent(xid, id), { xid, id: receipt.correction_id });
  expect(own).toBe(true);

  await page.goto(`/?xid=${encodeURIComponent(xid)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#consensus-text")).toContainText("Čeká na potvrzení dalšího člověka");
  await expect(page.locator("#confirm-cta")).toBeHidden();

  await page.goto(`/pomoc.html?mode=location&group_id=${encodeURIComponent(groupId)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#location-review-note")).toContainText("váš návrh");
  await expect(page.locator("#vote-up")).toBeDisabled();
  await expect(page.locator("#help-proposed-legend")).toBeVisible();
  const current = page.locator('#help-map .marker-dot:not(.is-pending)');
  const proposed = page.locator('#help-map .marker-dot.is-pending');
  await expect(current).toBeVisible();
  await expect(proposed).toBeVisible();
  const bounds = await map.boundingBox();
  for (const marker of [current, proposed]) {
    const box = await marker.boundingBox();
    expect(box.x + box.width / 2).toBeGreaterThan(bounds.x);
    expect(box.x + box.width / 2).toBeLessThan(bounds.x + bounds.width);
    expect(box.y + box.height / 2).toBeGreaterThan(bounds.y);
    expect(box.y + box.height / 2).toBeLessThan(bounds.y + bounds.height);
  }
  await page.setViewportSize({ width: 820, height: 1060 });
  await expect(proposed).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(proposed).toBeVisible();

  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(`/pomoc.html?mode=location&group_id=${encodeURIComponent(groupId)}`, { waitUntil: "domcontentloaded" });
  await expect(second.locator("#vote-up")).toBeEnabled();
  await expect(second.locator("#vote-up")).toHaveText("Potvrdit návrh");
  await second.locator("#vote-up").click();
  await expect(second.locator("#form-status")).toContainText("potvrzená");
  await other.close();
});

test("a newer proposal from another person is shown as foreign", async ({ page }) => {
  await page.goto("/pomoc.html?mode=location", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#current-xid")).not.toHaveText("—");
  const groupId = await page.locator("#current-xid").getAttribute("title");
  const candidate = await page.evaluate(async (focusGroupId) => {
    const result = await window.OldPragueCandidates.loadPage({ flow: "location", focusGroupId, limit: 1 });
    return { feature: result.items[0].primary, revision: result.revision };
  }, groupId);
  const xid = candidate.feature.properties.id;
  const [lon, lat] = candidate.feature.geometry.coordinates;
  const send = (revision, offset) => page.request.post("/api/corrections", { data: {
    xid, group_id: groupId, candidate_revision: revision, verdict: "wrong",
    lat: lat + offset, lon: lon + offset, message: "Návrh pro kontrolu pořadí",
  } });
  const first = await send(candidate.revision, .001);
  expect(first.status()).toBe(200);
  const firstId = (await first.json()).correction_id;
  await page.evaluate(({ xid, id }) => window.OldPragueOwnProposals.remember(xid, id), { xid, id: firstId });
  const latestSnapshot = await page.request.get("/api/review-state?snapshot=1");
  const revision = Number(latestSnapshot.headers()["x-community-revision"]);
  const second = await send(revision, .002);
  expect(second.status()).toBe(200);
  expect((await second.json()).correction_id).not.toBe(firstId);
  await page.goto(`/?xid=${encodeURIComponent(xid)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#consensus-text")).toContainText("Někdo navrhl jinou polohu");
  await expect(page.locator("#confirm-cta")).toBeVisible();
});

test("a blocked sessionStorage keeps own proposal recognition in page memory", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", { get() { throw new Error("blocked"); } });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.OldPragueOwnProposals));
  const recognized = await page.evaluate(() => {
    window.OldPragueOwnProposals.remember("X1", "42");
    return [
      window.OldPragueOwnProposals.isCurrent("X1", "42"),
      window.OldPragueOwnProposals.isCurrentInGroup([
        { properties: { id: "OTHER_VERSION" } },
        { properties: { id: "X1" } },
      ], "42"),
    ];
  });
  expect(recognized).toEqual([true, true]);
});

test("a failed refresh after saving does not repeat the correction POST", async ({ page }) => {
  const catalog = await (await page.request.get("/data/photos.geojson")).json();
  const xid = catalog.features[2].properties.id;
  let saved = false;
  let posts = 0;
  await page.route("**/api/review-state?fresh=1", (route) => {
    if (saved) return route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"Stav není dostupný"}' });
    return route.continue();
  });
  await page.route("**/api/corrections", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    const response = await route.fetch();
    saved = response.ok();
    await route.fulfill({ response });
  });
  await page.goto(`/?xid=${encodeURIComponent(xid)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#report-cta")).toBeVisible();
  await page.locator("#report-cta").click();
  const map = page.locator("#correction-map");
  await expect(map).toBeVisible();
  await map.click({ position: { x: 90, y: 90 } });
  await expect(page.locator('#feedback-form button[type="submit"]')).toBeEnabled();
  await page.locator('#feedback-form button[type="submit"]').click();
  await expect(page.locator("#form-status")).toContainText("uložená, ale aktuální stav se nepodařilo obnovit");
  expect(posts).toBe(1);
  await expect(page.locator('#feedback-form button[type="submit"]')).toBeDisabled();
});
