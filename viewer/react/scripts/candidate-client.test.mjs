import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const groupingSource = await readFile(
  new URL('../../static/grouping.js', import.meta.url),
  'utf8',
);
const candidateSource = await readFile(
  new URL('../../static/candidate-client.js', import.meta.url),
  'utf8',
);

function feature(id, groupId, coordinates) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: { id, group_id: groupId, signature: id },
  };
}

function createClient() {
  let revision = 1;
  const photos = {
    features: [
      feature('a', 'group-b', [14.4, 50.1]),
      feature('b', 'group-a', [14.4, 50.1]),
      feature('c', 'group-z', [14.4, 50.1]),
      feature('d', 'group-d', [14.4, 50.1]),
      feature('e', 'group-e', [14.4, 50.1]),
      feature('orphan', 'group-orphan', [14.4, 50.1]),
    ],
  };
  const reviewState = {
    groupCorrections: [],
    doneGroupIds: ['group-b'],
    mergeDecisions: [
      { group_id_a: 'group-a', group_id_b: 'group-e', verdict: 'different' },
    ],
    groupRoots: { 'group-b': 'group-a' },
    resolvedGroupByXid: { c: 'group-b' },
  };
  const assets = {
    '/data/photos.geojson': photos,
    '/data/orphan_xids.json': ['orphan'],
    '/data/series_version_clusters.json': {
      clusters: [{
        series_id: 'legacy-a',
        version_id: 'v1',
        xids: ['a', 'b', 'c'],
        representative_xid: 'b',
        max_distance: 3,
      }],
    },
    '/data/similarity_candidates.json': {
      pairs: [{
        group_id_a: 'group-b',
        group_id_b: 'group-d',
        xid_a: 'a',
        xid_b: 'd',
      }],
    },
  };
  const window = {};
  const context = vm.createContext({
    window,
    TextEncoder,
    btoa,
    Response,
    fetch: async (url) => {
      const path = new URL(url, 'https://example.test').pathname;
      if (path === '/api/review-state') {
        return new Response(JSON.stringify(reviewState), {
          headers: {
            'Content-Type': 'application/json',
            'X-Community-Revision': String(revision),
            'X-Community-Revision-Stable': '1',
            'X-Community-Data-Version': 'fixture-v1',
          },
        });
      }
      return new Response(JSON.stringify(assets[path]), {
        status: assets[path] ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  vm.runInContext(groupingSource, context);
  vm.runInContext(candidateSource, context);
  return {
    candidates: window.OldPragueCandidates,
    advanceRevision() {
      revision += 1;
    },
  };
}

test('candidate client resolves sparse roots before location, group, and duplicate enumeration', async () => {
  const { candidates } = createClient();

  const locations = await candidates.loadPage({ flow: 'location', limit: 50 });
  assert.deepEqual(
    Array.from(locations.items, (group) => group.id),
    ['group-d', 'group-e'],
  );

  const groups = await candidates.loadPage({ flow: 'group', limit: 50 });
  assert.deepEqual(Array.from(groups.items, (group) => group.id), ['group-a']);
  assert.deepEqual(Array.from(groups.items[0].version_clusters[0].xids), ['a', 'b', 'c']);

  const duplicates = await candidates.loadPage({ flow: 'duplicate', limit: 50 });
  assert.deepEqual(
    Array.from(duplicates.items, ({ key, source, groupAId, groupBId }) => ({
      key,
      source,
      groupAId,
      groupBId,
    })),
    [
      {
        key: 'group-a::group-d',
        source: 'similarity',
        groupAId: 'group-a',
        groupBId: 'group-d',
      },
      {
        key: 'group-d::group-e',
        source: 'coords',
        groupAId: 'group-d',
        groupBId: 'group-e',
      },
    ],
  );
  const expanded = candidates.expandDuplicatePair(duplicates.items[0]);
  assert.equal(expanded.groupA.items.length, 3);
  assert.equal(expanded.groupB.id, 'group-d');
});

test('candidate client rejects a cursor after the review revision changes', async () => {
  const { candidates, advanceRevision } = createClient();
  const first = await candidates.loadPage({ flow: 'location', limit: 1 });
  advanceRevision();
  await assert.rejects(
    candidates.loadPage({
      flow: 'location',
      cursor: first.nextCursor,
      limit: 1,
    }),
    (error) => error?.status === 409,
  );
});
