import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const address = { items: [{ name: 'Letenská', location: 'Praha', position: { lat: 50.09, lon: 14.41 } }] };
async function open(page) {
  await page.route('https://api.mapy.com/v1/suggest**', (route) => route.fulfill({ json: address }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#map-search')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#photo-count')).not.toHaveText('—');
  await expect(page.locator('#map-search')).toHaveAttribute('role', 'combobox');
}

test('typing preserves the confirmed filter; Enter, Escape, clear and history', async ({ page }) => {
  await open(page);
  const input = page.locator('#map-search');
  const initialCount = await page.locator('#photo-count').textContent();
  await input.fill('Letenská');
  await expect(page.locator('#photo-count')).toHaveText(initialCount);
  await input.press('Enter');
  await expect(page.locator('#search-filter')).toContainText('Text: Letenská');
  await expect(page).toHaveURL(/search=text.*search_text=/);
  const filteredCount = await page.locator('#photo-count').textContent();
  await input.fill('Nový dotaz');
  await expect(page.locator('#photo-count')).toHaveText(filteredCount);
  await input.press('Escape');
  await expect(page.locator('#search-filter')).toContainText('Text: Letenská');
  await page.getByRole('button', { name: 'Zrušit filtr hledání' }).click();
  await expect(page.locator('#search-filter')).toBeHidden();
  await expect(page.locator('#photo-count')).toHaveText(initialCount);
  await page.goBack();
  await expect(page.locator('#search-filter')).toContainText('Text: Letenská');
  await page.goForward();
  await expect(page.locator('#search-filter')).toBeHidden();
  await input.fill('a');
  await input.press('Enter');
  await expect(page.locator('#search-filter')).toBeHidden();
  await expect(page.locator('#search-link-status')).toContainText('alespoň dva znaky');
});

test('real archive place and author results, description XID, URL and map address', async ({ page, request }) => {
  test.setTimeout(90_000);
  const catalog = await (await request.get('/data/photos.geojson')).json();
  const sample = catalog.features.find((feature) => feature.properties.places?.length && feature.properties.authors?.length);
  expect(sample, 'stage 003 must be integrated; fixtures are not sufficient').toBeTruthy();
  await open(page);
  const input = page.locator('#map-search');
  const place = sample.properties.places[0];
  await input.fill(place.label);
  const option = page.locator('[role=option][data-kind=place]').filter({ hasText: place.label }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator('#search-filter')).toContainText('Místo:');
  await expect(page).toHaveURL(/search=place/);
  const placeUrl = page.url();
  await input.fill('Letenská');
  await page.locator('[role=option][data-kind=address]').first().click();
  expect(page.url()).toBe(placeUrl);
  await expect(page.locator('#search-filter')).toContainText('Místo:');
  await input.fill(sample.properties.authors[0].label);
  await page.locator('[role=option][data-kind=author]').first().click();
  await expect(page.locator('#search-filter')).toContainText('Autor:');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#search-filter')).toContainText('Autor:');
  await input.fill(sample.properties.description.slice(0, 25));
  const description = page.locator('[role=option][data-kind=description]').first();
  await expect(description).toBeVisible();
  await description.click();
  await expect(page.locator('#archive-modal')).toHaveClass(/is-open/);
  await expect(page).toHaveURL(/xid=/);
  await expect(page.locator('#search-filter')).toContainText('Autor:');
});

for (const status of [429, 500]) {
  test(`provider ${status} preserves local results and never calls Nominatim`, async ({ page }) => {
    let nominatim = 0;
    page.on('request', (request) => { if (request.url().includes('nominatim.openstreetmap.org')) nominatim++; });
    await open(page);
    await page.route('https://api.mapy.com/v1/suggest**', (route) => route.fulfill({ status, json: {} }));
    await page.locator('#map-search').fill('Letenská');
    await expect(page.locator('#search-results')).toContainText('Adresy teď nelze načíst');
    await expect(page.locator('[data-kind=place]').first()).toBeVisible();
    expect(nominatim).toBe(0);
    await page.locator('#map-search').press('Enter');
    await expect(page.locator('#search-filter')).toContainText('Text: Letenská');
  });
}

test('clearing a query invalidates a delayed address response; IME Enter does not confirm', async ({ page }) => {
  await open(page);
  await page.route('https://api.mapy.com/v1/suggest**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ json: address }).catch(() => {});
  });
  const input = page.locator('#map-search');
  await input.fill('Letenská');
  await page.waitForTimeout(450);
  await input.fill('');
  await page.waitForTimeout(1100);
  await expect(page.locator('#search-results')).toBeHidden();
  await input.dispatchEvent('compositionstart');
  await input.fill('Letenská');
  await input.press('Enter');
  await expect(page.locator('#search-filter')).toBeHidden();
  await input.dispatchEvent('compositionend');
  await input.press('Escape');
  await input.press('Tab');
  await expect(input).not.toBeFocused();
});

test('unknown entity link is explained without losing unrelated URL parameters', async ({ page }) => {
  await page.goto('/?search=place&search_id=missing&foo=keep');
  await expect(page.locator('#search-link-status')).toContainText('není v katalogu');
  await expect(page.locator('#search-filter')).toBeHidden();
  await page.locator('#map-search').fill('Letenská');
  await page.locator('#map-search').press('Enter');
  expect(new URL(page.url()).searchParams.get('foo')).toBe('keep');
});

// Explicit semantic fixtures exercise the standalone UI independently of stage 003.
// They never substitute for the real archive integration test above.
test('semantic UI fixtures: keyboard selection, pagination and address failures', async ({ page }) => {
  await page.setContent('<input id="fixture-input"><div id="fixture-chip"></div><div id="fixture-popup"></div><div id="fixture-status"></div>');
  await page.addScriptTag({ content: readFileSync(new URL('../viewer/static/search-ui.js', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    window.fixtureActions = [];
    window.OldPragueSearchUI.mount({
      input: document.querySelector('#fixture-input'), popup: document.querySelector('#fixture-popup'),
      chip: document.querySelector('#fixture-chip'), status: document.querySelector('#fixture-status'),
      getResults: () => ({ places: Array.from({ length: 12 }, (_, i) => ({ kind: 'place', id: `p${i}`, label: `Místo ${i}`, detail: 'Podle údajů archivu' })) }),
      suggest: async () => { throw new Error('unavailable'); },
      onSelect: (item) => window.fixtureActions.push(item.id),
      onText: (query) => window.fixtureActions.push(`text:${query}`), onClear: () => {},
    });
  });
  const input = page.locator('#fixture-input');
  await input.fill('Místo');
  await expect(page.locator('[role=option]')).toHaveCount(5);
  await input.press('Enter');
  expect(await page.evaluate(() => window.fixtureActions)).toEqual(['text:Místo']);
  await input.fill('Míst');
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-option-4');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-option-0');
  await expect(page.locator('#fixture-popup')).toContainText('Adresy teď nelze načíst');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-option-0');
  await input.press('Enter');
  expect(await page.evaluate(() => window.fixtureActions)).toEqual(['text:Místo', 'p0']);
  await input.fill('Místa');
  await input.press('Tab');
  await expect(page.getByRole('button', { name: 'Další místa' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[role=option]')).toHaveCount(10);
  await expect(input).toBeFocused();
  expect(await page.locator('[role=option] button').count()).toBe(0);
});

test('confirmed search intersects the year filter and a zero-result search can be cleared', async ({ page }) => {
  await open(page);
  await page.locator('#filters-toggle').click();
  const range = page.locator('#year-min');
  const minimum = Number(await range.getAttribute('min'));
  const maximum = Number(await range.getAttribute('max'));
  const midpoint = Math.floor((minimum + maximum) / 2);
  const beforeYearChange = await page.locator('#photo-count').textContent();
  await range.evaluate((element, year) => {
    element.value = String(year);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, midpoint);
  await expect(page.locator('#photo-count')).not.toHaveText(beforeYearChange);
  const narrowed = await page.locator('#photo-count').textContent();
  const input = page.locator('#map-search');
  await input.fill('NenalezitelnýDotaz987654');
  await expect(page.locator('#photo-count')).toHaveText(narrowed);
  await input.press('Enter');
  await expect(page.locator('#photo-count')).toHaveText(/^0(?: \/|$)/);
  await expect(range).toHaveValue(String(midpoint));
  await input.fill('');
  await input.press('Enter');
  await expect(page.locator('#search-filter')).toContainText('Text: NenalezitelnýDotaz987654');
  await page.getByRole('button', { name: 'Zrušit filtr hledání' }).click();
  await expect(page.locator('#photo-count')).toHaveText(narrowed);
  await expect(range).toHaveValue(String(midpoint));
});

for (const failure of ['missing key', 'timeout']) {
  test(`address ${failure} keeps local matches available`, async ({ page }) => {
    if (failure === 'missing key') {
      await page.route('**/api/config', async (route) => {
        const response = await route.fetch();
        const config = await response.json();
        await route.fulfill({ json: { ...config, mapyCzApiKey: '' } });
      });
    }
    await open(page);
    if (failure === 'timeout') {
      await page.route('https://api.mapy.com/v1/suggest**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 6500));
        await route.fulfill({ json: address }).catch(() => {});
      });
    }
    await page.locator('#map-search').fill('Letenská');
    await expect(page.locator('#search-results')).toContainText('Adresy teď nelze načíst');
    await expect(page.locator('[data-kind=place]').first()).toBeVisible();
    await page.locator('[data-kind=place]').filter({ hasText: 'Malá Strana' }).first().click();
    await expect(page.locator('#search-filter')).toContainText('Místo: Letenská — Malá Strana');
  });
}

test('a description fixture opens the matching secondary XID and author-only matches stay separate', async ({ page, request }) => {
  // The published catalogue currently gives grouped scans the same description.
  // Keep its real entity records, and introduce two explicit description variants
  // to prove selection when the matching member is not the representative.
  const catalog = await (await request.get('/data/photos.geojson')).json();
  const features = structuredClone(catalog.features.filter((feature) => feature.properties.authors?.length).slice(0, 2));
  const groupId = features[0].properties.id;
  features.forEach((feature, index) => {
    feature.properties.group_id = groupId;
    feature.properties.group_root = groupId;
    feature.properties.signature = String(index);
    feature.properties.description = index ? 'Vedlejší snímek: unikátní průhled pro test omniboxu.' : 'Hlavní snímek domu.';
  });
  await page.route('**/data/photos.geojson', (route) => route.fulfill({ json: { type: 'FeatureCollection', features } }));
  await page.route('**/data/orphan_xids.json', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/review-state**', (route) => route.fulfill({ json: {} }));
  await open(page);
  await page.locator('#map-search').fill('unikátní průhled');
  await page.locator('[data-kind=description]').first().click();
  await expect(page.locator('#archive-modal')).toHaveClass(/is-open/);
  expect(new URL(page.url()).searchParams.get('xid')).toBe(features[1].properties.id);
  await page.locator('#archive-modal').getByRole('button', { name: 'Zavřít', exact: true }).click();
  await page.locator('#map-search').fill(features[0].properties.authors[0].label);
  await expect(page.locator('[data-kind=author]').first()).toBeVisible();
  expect(await page.locator('[data-kind=description]').count()).toBe(0);
});

test('real long results fit mobile, tablet and desktop without horizontal scrolling', async ({ page }) => {
  await open(page);
  for (const [width, height] of [[390, 844], [820, 1060], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#map-search').fill('Chalupníček');
    await expect(page.locator('[data-kind=author]').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#map-search').fill('Letenská');
    await expect(page.locator('[data-kind=place]').filter({ hasText: 'Malá Strana' }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.local/omnibox-${width}.png` });
  }
});

for (const [label, shortQuery] of [['empty', ''], ['one character', 'a']]) {
  test(`a short (${label}) query cannot select stale suggestions with ArrowDown and Enter`, async ({ page }) => {
    await open(page);
    const input = page.locator('#map-search');
    await input.fill('Eckert');
    await input.press('Enter');
    await expect(page.locator('#search-filter')).toContainText('Text: Eckert');
    const confirmedUrl = page.url();
    const confirmedCount = await page.locator('#photo-count').textContent();
    await input.fill('Letenská');
    await expect(page.locator('[data-kind=place]').filter({ hasText: 'Malá Strana' }).first()).toBeVisible();
    await input.fill(shortQuery);
    await expect(page.locator('#search-results')).toBeHidden();
    await expect(input).toHaveAttribute('aria-controls', 'search-results');
    await input.press('ArrowDown');
    await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/);
    await input.press('Enter');
    await expect(page.locator('#search-filter')).toContainText('Text: Eckert');
    expect(page.url()).toBe(confirmedUrl);
    await expect(page.locator('#photo-count')).toHaveText(confirmedCount);
    await expect(page.locator('#archive-modal')).not.toHaveClass(/is-open/);
  });
}
