import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const address = { items: [{ name: 'Letenská', location: 'Praha', position: { lat: 50.09, lon: 14.41 } }] };
async function open(page) {
  await page.route('https://api.mapy.com/v1/suggest**', (route) => route.fulfill({ json: address }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
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
});

test('real archive place and author results, description XID, URL and map address', async ({ page, request }) => {
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
  await page.reload();
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
