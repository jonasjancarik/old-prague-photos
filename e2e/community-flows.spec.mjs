import { expect, test } from "@playwright/test";

async function waitForEnabled(page, selector) {
  await expect(page.locator(selector)).toBeEnabled();
}

async function waitForFlow(page, readySelector, buttonSelector) {
  await expect(page.locator(readySelector)).not.toHaveText("—");
  await waitForEnabled(page, buttonSelector);
}

async function postFromOrigin(request, path, data) {
  return request.post(path, {
    data,
    headers: { Origin: "http://127.0.0.1:8790" },
  });
}

test.describe.serial("community contribution flows", () => {
  test("keeps the map performance confirmation inside the page", async ({ page }) => {
    let nativeDialogCount = 0;
    page.on("dialog", async (dialog) => {
      nativeDialogCount += 1;
      await dialog.dismiss();
    });

    await page.goto("/");
    await expect(page.locator("#photo-count")).not.toHaveText("—");
    await page.locator(".cluster-toggle-container .toggle-switch").click();

    await expect(page.locator("#cluster-warning")).toBeVisible();
    await expect(page.locator("#cluster-toggle")).toBeChecked();
    expect(nativeDialogCount).toBe(0);

    await page.getByRole("button", { name: "Zobrazit jednotlivé body" }).click();
    await expect(page.locator("#cluster-warning")).toBeHidden();
    await expect(page.locator("#cluster-toggle")).not.toBeChecked();
    await expect(page.locator("#cluster-toggle")).toBeFocused();
    expect(nativeDialogCount).toBe(0);
  });

  test("submits a location correction from the map", async ({ page }) => {
    await page.goto("/pomoc.html?mode=location");
    await waitForFlow(page, "#current-xid", "#vote-down");
    await page.locator("#vote-down").click();

    const map = page.locator("#help-map");
    await expect(map).toBeVisible();
    const box = await map.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.42);

    await expect(page.locator("#help-correction-modal")).toHaveClass(/is-open/);
    await page.locator("#help-message").fill("Automatizované ověření opravy polohy");
    await expect(page.locator("#submit-correction")).toBeEnabled();
    const correctionResponse = page.waitForResponse(
      (response) => response.url().endsWith("/api/corrections") && response.request().method() === "POST",
    );
    await page.locator("#submit-correction").click();
    expect((await correctionResponse).ok()).toBeTruthy();

    const review = await page.request.get("/api/admin/review");
    expect(review.ok()).toBeTruthy();
    expect((await review.json()).counts.pendingCorrections).toBeGreaterThan(0);
  });

  test("two contributors propose a split and a curator reassigns a photo", async ({
    browser,
  }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    await firstPage.goto("/group-review.html");
    await waitForFlow(firstPage, "#current-group", "#group-mark-split");
    const firstGroup = await firstPage.locator("#current-group").innerText();
    const firstVote = firstPage.waitForResponse(
      (response) => response.url().endsWith("/api/group-review-votes") && response.request().method() === "POST",
    );
    await firstPage.locator("#group-mark-split").click();
    expect((await firstVote).ok()).toBeTruthy();

    await secondPage.goto("/group-review.html");
    await waitForFlow(secondPage, "#current-group", "#group-mark-split");
    expect(await secondPage.locator("#current-group").innerText()).toBe(firstGroup);
    const secondVote = secondPage.waitForResponse(
      (response) => response.url().endsWith("/api/group-review-votes") && response.request().method() === "POST",
    );
    await secondPage.locator("#group-mark-split").click();
    expect((await secondVote).ok()).toBeTruthy();

    const adminPage = await firstContext.newPage();
    await adminPage.goto("/admin.html");
    await expect(adminPage.locator("#admin-operations")).toContainText(
      "Změny na veřejném webu",
    );
    await expect(adminPage.locator(".split-candidate")).toBeVisible();
    await adminPage.locator(".split-member-card input[type=checkbox]").first().check();
    await adminPage.getByPlaceholder("Důvod rozdělení").fill(
      "E2E ověření kurátorského přesunu",
    );
    const curatorMove = adminPage.waitForResponse(
      (response) => response.url().endsWith("/api/admin/group-membership") && response.request().method() === "POST",
    );
    await adminPage.getByRole("button", { name: "Přesunout vybrané fotografie" }).click();
    expect((await curatorMove).ok()).toBeTruthy();
    await expect(adminPage.locator(".membership-history-item")).toBeVisible();
    await expect(adminPage.locator("#list-membership-history")).toContainText(
      "E2E ověření kurátorského přesunu",
    );

    await firstContext.close();
    await secondContext.close();
  });

  test("records and undoes a duplicate decision", async ({ page }) => {
    await page.goto("/dup-review.html?mode=dedupe");
    await expect(page.locator("#pair-source")).not.toHaveText("Vybráno podle: —");
    await waitForEnabled(page, "#mark-same");
    const decision = page.waitForResponse(
      (response) => response.url().endsWith("/api/merges") && response.request().method() === "POST",
    );
    await page.locator("#mark-same").click();
    expect((await decision).ok()).toBeTruthy();
    await expect(page.locator("#undo-last")).toBeEnabled();
    const undo = page.waitForResponse(
      (response) => response.url().endsWith("/api/merges") && response.request().method() === "POST",
    );
    await page.locator("#undo-last").click();
    const undoResponse = await undo;
    expect(undoResponse.ok()).toBeTruthy();
    expect((await undoResponse.json()).decision.verdict).toBe("undo");
  });

  test("recovers controls after a slow failed submission", async ({ page }) => {
    await page.route("**/api/corrections", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Dočasná testovací chyba" }),
      });
    });
    await page.goto("/pomoc.html?mode=location");
    await waitForFlow(page, "#current-xid", "#vote-up");
    await page.locator("#vote-up").click();
    await expect(page.locator("#vote-up")).toBeDisabled();
    await expect(page.locator("#form-status")).toContainText("Dočasná testovací chyba");
    await expect(page.locator("#vote-up")).toBeEnabled();
  });

  test("rejects a stale candidate cursor after a contribution", async ({ request }) => {
    const pageResponse = await request.get(
      "/api/community-candidates?flow=location&limit=1",
    );
    expect(pageResponse.ok()).toBeTruthy();
    const candidates = await pageResponse.json();
    expect(candidates.nextCursor).toBeTruthy();
    const candidate = candidates.items[0];

    const write = await postFromOrigin(request, "/api/corrections", {
      xid: candidate.primary.properties.id,
      group_id: candidate.id,
      verdict: "ok",
    });
    expect(write.ok()).toBeTruthy();

    const stale = await request.get(
      `/api/community-candidates?flow=location&limit=1&cursor=${encodeURIComponent(candidates.nextCursor)}`,
    );
    expect(stale.status()).toBe(409);
  });

  test("keeps the correction dialog keyboard-contained and closes with Escape", async ({
    page,
  }) => {
    await page.goto("/pomoc.html?mode=location");
    await waitForFlow(page, "#current-xid", "#vote-down");
    await page.locator("#vote-down").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#open-flag")).toBeVisible();
    await page.locator("#open-flag").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#help-correction-modal")).toHaveClass(/is-open/);
    await expect(page.getByRole("button", { name: "Zavřít" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.locator("#help-correction-modal").evaluate(
        (modal) => modal.contains(document.activeElement),
      ),
    ).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(page.locator("#help-correction-modal")).not.toHaveClass(/is-open/);
    await expect(page.locator("#vote-down")).toBeFocused();
  });
});
