import { expect, test } from '@playwright/test';

test('published archive fields build a browser index with current membership', async ({page})=>{
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#map .leaflet-marker-icon').first()).toBeVisible();
  const result = await page.evaluate(async()=>{
    const helper = await import('/search-index.js');
    const catalog = await (await fetch('/data/photos.geojson')).json();
    const features = catalog.features;
    const index = helper.buildSearchIndex(features);
    const state = helper.updateSearchMembership(index);
    const results = ['Letenská','Letenské','Letenskou'].map(q=>helper.searchIndex(state,q));
    const street = results[0].places.find(p=>p.label==='Letenská' && p.district==='Malá Strana');
    const members = features.filter(f=>f.properties.places.some(p=>p.id===street.id));
    const moved = new Map(members.map(f=>[f.properties.id,'test-merged']));
    const merged = helper.searchIndex(helper.updateSearchMembership(index,moved),'Letenská').places.find(p=>p.id===street.id);
    return {total:features.length,unique:index.photos.size,streetCount:street.photoCount,
      expected:members.length,groupCount:street.groupCount,expectedGroups:new Set(members.map(f=>f.properties.group_id)).size,
      variants:results.map(r=>r.places.some(p=>p.id===street.id)),mergedGroups:merged.groupCount,
      matched:street.xids.includes(street.matchedXid),hasTerms:features.every(f=>Array.isArray(f.properties.archive_place_terms))};
  });
  expect(result.unique).toBe(result.total);
  expect(result.hasTerms).toBe(true);
  expect(result.streetCount).toBeGreaterThan(0);
  expect(result.streetCount).toBe(result.expected);
  expect(result.groupCount).toBe(result.expectedGroups);
  expect(result.variants).toEqual([true,true,true]);
  expect(result.mergedGroups).toBe(1);
  expect(result.matched).toBe(true);
});
