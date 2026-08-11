import { expect, test } from "@playwright/test";

async function waitForEnabled(page, selector) {
  await expect(page.locator(selector)).toBeEnabled();
}

async function waitForFlow(page, readySelector, buttonSelector) {
  await expect(page.locator(readySelector)).not.toHaveText("—");
  await waitForEnabled(page, buttonSelector);
}

async function openPage(page, path) {
  // The UI is ready at DOMContentLoaded. Waiting for the full load event makes
  // the suite depend on optional third-party font and stylesheet CDNs.
  await page.goto(path, { waitUntil: "domcontentloaded" });
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

    await openPage(page, "/");
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
    await openPage(page, "/pomoc.html?mode=location");
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

  test("opens a pending map proposal in the exact location-review flow without confirming it", async ({
    page,
    request,
  }) => {
    const candidatesResponse = await request.get(
      "/api/community-candidates?flow=location&limit=1",
    );
    expect(candidatesResponse.ok()).toBeTruthy();
    const candidate = (await candidatesResponse.json()).items[0];
    expect(candidate).toBeTruthy();
    const [lon, lat] = candidate.primary.geometry.coordinates;
    const proposal = await postFromOrigin(request, "/api/corrections", {
      xid: candidate.primary.properties.id,
      group_id: candidate.id,
      verdict: "wrong",
      lat: Number(lat) + 0.001,
      lon: Number(lon) + 0.001,
      message: "E2E návrh pro přesné předání do kontroly",
    });
    expect(proposal.ok()).toBeTruthy();

    let confirmationPosts = 0;
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        new URL(outgoing.url()).pathname === "/api/corrections"
      ) {
        confirmationPosts += 1;
      }
    });
    await openPage(
      page,
      `/?xid=${encodeURIComponent(candidate.primary.properties.id)}`,
    );
    await expect(page.locator("#confirm-cta")).toBeVisible();
    await expect(page.locator("#confirm-cta")).toHaveText("Zkontrolovat návrh");
    await page.locator("#confirm-cta").click();
    await expect(page).toHaveURL(/\/pomoc(?:\.html)?\?/u);
    const focusedUrl = new URL(page.url());
    expect(focusedUrl.searchParams.get("mode")).toBe("location");
    expect(focusedUrl.searchParams.get("group_id")).toBe(candidate.id);
    await expect(page.locator("#current-xid")).toHaveAttribute("title", candidate.id);
    expect(confirmationPosts).toBe(0);
  });

  test("refreshes changed proposal evidence before another location decision", async ({
    page,
  }) => {
    let replaceCurrentProposal = false;
    let currentGroupId = "";
    let snapshotResponses = 0;
    await page.route("**/api/review-state?snapshot=1", async (route) => {
      const upstream = await route.fetch();
      if (!replaceCurrentProposal || !currentGroupId) {
        await route.fulfill({ response: upstream });
        snapshotResponses += 1;
        return;
      }
      const payload = await upstream.json();
      payload.groupCorrections = [
        ...(payload.groupCorrections || []).filter(
          (item) => item?.group_id !== currentGroupId,
        ),
        {
          group_id: currentGroupId,
          correction_state: "pending",
          anchor_type: "correction",
          anchor_id: "poll-proposal",
          proposed_id: "poll-proposal",
          proposed_has_coordinates: true,
          proposed_lat: 50.091,
          proposed_lon: 14.431,
          location_revision: JSON.stringify([currentGroupId, "poll-proposal"]),
          needs_confirmation: true,
          done: false,
        },
      ];
      payload.doneGroupIds = (payload.doneGroupIds || []).filter(
        (groupId) => groupId !== currentGroupId,
      );
      await route.fulfill({
        response: upstream,
        body: JSON.stringify(payload),
        headers: {
          ...upstream.headers(),
          "content-type": "application/json",
        },
      });
      snapshotResponses += 1;
    });

    await openPage(page, "/pomoc.html?mode=location");
    await waitForFlow(page, "#current-xid", "#vote-down");
    await expect.poll(() => snapshotResponses).toBeGreaterThanOrEqual(2);
    currentGroupId = await page.locator("#current-xid").getAttribute("title");
    await page.locator("#vote-down").click();
    await expect(page.locator("#help-wrong-actions")).toBeVisible();

    replaceCurrentProposal = true;
    await page.evaluate(async () => {
      await window.refreshRemainingCloud({ force: true });
    });
    await expect(page.locator("#form-status")).toContainText(
      "Prohlédněte si aktualizované body a rozhodněte se znovu",
    );
    await expect(page.locator("#help-wrong-actions")).toBeHidden();
    await expect(page.locator("#vote-down")).not.toHaveClass(/is-voted/u);
    await expect(page.locator("#vote-up")).toHaveText("Potvrdit návrh");
  });

  test("two contributors propose a split and a curator reassigns a photo", async ({
    browser,
  }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    await openPage(firstPage, "/group-review.html");
    await waitForFlow(firstPage, "#current-group", "#group-mark-split");
    const firstGroup = await firstPage.locator("#current-group").innerText();
    const firstVote = firstPage.waitForResponse(
      (response) => response.url().endsWith("/api/group-review-votes") && response.request().method() === "POST",
    );
    await firstPage.locator("#group-mark-split").click();
    expect((await firstVote).ok()).toBeTruthy();

    await openPage(secondPage, "/group-review.html");
    await waitForFlow(secondPage, "#current-group", "#group-mark-split");
    expect(await secondPage.locator("#current-group").innerText()).toBe(firstGroup);
    const secondVote = secondPage.waitForResponse(
      (response) => response.url().endsWith("/api/group-review-votes") && response.request().method() === "POST",
    );
    await secondPage.locator("#group-mark-split").click();
    expect((await secondVote).ok()).toBeTruthy();

    const adminPage = await firstContext.newPage();
    await openPage(adminPage, "/admin.html");
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
    await openPage(page, "/dup-review.html?mode=dedupe");
    await expect(page.locator("#pair-source")).not.toHaveText("Vybráno podle: —");
    await waitForEnabled(page, "#mark-same");
    const decision = page.waitForResponse(
      (response) => response.url().endsWith("/api/merges") && response.request().method() === "POST",
    );
    await page.locator("#mark-same").click();
    const decisionResponse = await decision;
    expect(decisionResponse.ok()).toBeTruthy();
    expect(
      Number.isSafeInteger(
        decisionResponse.request().postDataJSON().candidate_revision,
      ),
    ).toBeTruthy();
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
    await openPage(page, "/pomoc.html?mode=location");
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
      location_revision: candidate.primary.properties.location_revision,
      proposal_id: candidate.primary.properties.proposed_id || null,
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
    await openPage(page, "/pomoc.html?mode=location");
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

  test("keeps the task chooser in browser history and names each decision", async ({
    page,
  }) => {
    await openPage(page, "/pomoc.html");
    await expect(page.locator("[data-mode-picker]")).toBeVisible();
    await expect(page.locator("[data-mode-back]")).toBeHidden();

    await page.locator('[data-mode-select="location"]').click();
    await expect(page.locator('[data-mode-flow="location"]')).toBeVisible();
    await expect(page.locator("[data-mode-back]")).toBeVisible();
    await expect(page.locator("#vote-up")).toHaveText("Poloha sedí");
    await expect(page.locator("#vote-down")).toHaveText("Poloha nesedí");

    await page.locator("[data-mode-back]").click();
    await expect(page.locator("[data-mode-picker]")).toBeVisible();
    await page.goBack();
    await expect(page.locator('[data-mode-flow="location"]')).toBeVisible();

    await openPage(page, "/dup-review.html?mode=dedupe");
    await expect(page.locator("#mark-same")).toHaveText("Sloučit skupiny");
    await expect(page.locator("#mark-different")).toHaveText(
      "Ponechat skupiny zvlášť",
    );
  });

  test("does not retain an optional email in the browser", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("old-prague-help-email", "legacy@example.test");
    });
    await openPage(page, "/pomoc.html?mode=location");
    await waitForFlow(page, "#current-xid", "#vote-down");

    await expect(page.locator("#help-email")).toHaveValue("");
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("old-prague-help-email")
      ),
    ).toBeNull();
    await expect(page.locator("#help-email-privacy")).toContainText(
      "web si ho neuloží pro příští hlášení",
    );

    await openPage(page, "/");
    await expect(page.locator('input[name="email"]')).toHaveAttribute(
      "aria-describedby",
      "correction-email-privacy",
    );
    await expect(page.locator("#correction-email-privacy")).toContainText(
      "použijeme ho jen pro případné upřesnění tohoto hlášení",
    );
  });

  test("keeps the chooser and duplicate comparison inside narrow viewports", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await openPage(page, "/pomoc.html");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBeTruthy();

    await openPage(page, "/dup-review.html?mode=dedupe");
    await expect(page.locator("#pair-source")).not.toHaveText("Vybráno podle: —");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBeTruthy();

    await page.setViewportSize({ width: 375, height: 812 });
    const leftFrame = await page.locator("#left-zoom").locator("..").boundingBox();
    const rightFrame = await page.locator("#right-zoom").locator("..").boundingBox();
    expect(leftFrame).not.toBeNull();
    expect(rightFrame).not.toBeNull();
    expect(Math.abs(leftFrame.y - rightFrame.y)).toBeLessThan(2);
    expect(leftFrame.x).toBeLessThan(rightFrame.x);
    await expect(page.getByText("Skupina A", { exact: true })).toBeVisible();
    await expect(page.getByText("Skupina B", { exact: true })).toBeVisible();
    await expect(page.getByText("Údaje skupiny A", { exact: true })).toBeVisible();
    await expect(page.getByText("Údaje skupiny B", { exact: true })).toBeVisible();
    const focusSectionOrder = await page.locator(".duplicate-review-grid").evaluate(
      (grid) => {
        const focusable = Array.from(
          grid.querySelectorAll(
            'a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
          ),
        );
        return focusable
          .map((element) => element.closest("[data-review-section]")?.dataset.reviewSection)
          .filter((section, index, sections) => section && section !== sections[index - 1]);
      },
    );
    expect(focusSectionOrder.slice(0, 4)).toEqual([
      "preview-a",
      "preview-b",
      "details-a",
      "details-b",
    ]);
  });

  test("keeps saved feedback visible and clears an exhausted comparison", async ({
    page,
  }) => {
    await page.route("https://unpkg.com/**", (route) => route.abort());
    let candidateRequests = 0;
    await page.route("**/api/community-candidates?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("flow") !== "duplicate") {
        await route.continue();
        return;
      }
      candidateRequests += 1;
      if (candidateRequests === 1) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], total: 0, nextCursor: null }),
      });
    });
    await page.route("**/api/merges", async (route) => {
      const decision = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, decision }),
      });
    });

    await page.goto("/dup-review.html?mode=dedupe", {
      waitUntil: "domcontentloaded",
    });
    await waitForEnabled(page, "#mark-same");
    await expect(page.locator("#left-details")).not.toBeEmpty();
    await page.locator("#mark-same").click();

    await expect(page.locator("#review-status")).toContainText(
      "Rozhodnutí sloučit skupiny je uložené",
    );
    await page.waitForTimeout(700);
    await expect(page.locator("#review-status")).toContainText(
      "Rozhodnutí sloučit skupiny je uložené",
    );
    await expect(page.locator("#pair-source")).toHaveText("Vybráno podle: —");
    await expect(page.locator("#left-details")).toBeEmpty();
    await expect(page.locator("#right-details")).toBeEmpty();
    await expect(page.locator("#left-iframe")).not.toHaveAttribute("src");
    await expect(page.locator("#right-iframe")).not.toHaveAttribute("src");
  });

  test("keeps exact-pair undo available when refreshing after a saved vote fails", async ({
    page,
  }) => {
    let candidateRequests = 0;
    await page.route("**/api/community-candidates?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("flow") !== "duplicate") {
        await route.continue();
        return;
      }
      candidateRequests += 1;
      if (candidateRequests === 1) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Dočasná chyba seznamu" }),
      });
    });
    await page.route("**/api/merges", async (route) => {
      const decision = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, decision }),
      });
    });

    await openPage(page, "/dup-review.html?mode=dedupe");
    await waitForEnabled(page, "#mark-same");
    await page.locator("#mark-same").click();
    await expect(page.locator("#review-status")).toContainText(
      "Stále ho můžete vrátit tlačítkem Zpět",
    );
    await expect(page.locator("#undo-last")).toBeEnabled();
  });

  test("continues group review when local progress storage is unavailable", async ({
    page,
  }) => {
    await page.route("https://unpkg.com/**", (route) => route.abort());
    await page.addInitScript(() => {
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === "old-prague-group-review-reviewed") {
          throw new DOMException("Storage disabled", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      };
    });
    await page.route("**/api/group-review-votes", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/group-review.html", { waitUntil: "domcontentloaded" });
    await waitForFlow(page, "#current-group", "#group-mark-ok");
    const firstGroup = await page.locator("#current-group").innerText();
    await page.locator("#group-mark-ok").click();
    await expect(page.locator("#group-status")).toContainText(
      "Potvrzení skupiny je uložené",
    );
    await expect.poll(() => page.locator("#current-group").innerText()).not.toBe(
      firstGroup,
    );
  });
});
