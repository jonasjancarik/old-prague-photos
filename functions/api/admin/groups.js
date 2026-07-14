import { authorizeAdmin } from "../_admin_auth.js";
import {
  loadPhotoFeatureMap,
  loadXidGroupMap,
} from "../_review_state.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalize(value) {
  return String(value || "").trim();
}

function searchableText(groupId, feature) {
  const props = feature?.properties || {};
  return [
    groupId,
    props.id,
    props.description,
    props.signature,
    props.author,
    props.date_label,
  ]
    .map(normalize)
    .join(" ")
    .toLocaleLowerCase("cs-CZ");
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }
  const authResponse = await authorizeAdmin(request, env);
  if (authResponse) return authResponse;

  const query = normalize(new URL(request.url).searchParams.get("query"))
    .toLocaleLowerCase("cs-CZ")
    .slice(0, 200);
  if (query.length < 2) {
    return jsonResponse({ items: [] });
  }

  const [xidGroupMap, photoFeatureMap] = await Promise.all([
    loadXidGroupMap(request, env),
    loadPhotoFeatureMap(request, env),
  ]);
  const groups = new Map();
  xidGroupMap.forEach((groupId, xid) => {
    const feature = photoFeatureMap.get(xid);
    let item = groups.get(groupId);
    if (!item) {
      item = {
        group_id: groupId,
        member_count: 0,
        sample_xid: xid,
        description: normalize(feature?.properties?.description),
        match: false,
      };
      groups.set(groupId, item);
    }
    item.member_count += 1;
    if (searchableText(groupId, feature).includes(query)) {
      item.match = true;
      item.sample_xid = xid;
      item.description = normalize(feature?.properties?.description);
    }
  });

  const items = Array.from(groups.values())
    .filter((item) => item.match)
    .sort((left, right) => {
      const leftExact = left.group_id.toLocaleLowerCase("cs-CZ").startsWith(query);
      const rightExact = right.group_id.toLocaleLowerCase("cs-CZ").startsWith(query);
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      return left.group_id.localeCompare(right.group_id);
    })
    .slice(0, 20)
    .map(({ match, ...item }) => item);

  return jsonResponse({ items });
}
