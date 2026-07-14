import assert from "node:assert/strict";
import test from "node:test";

import { isValidCandidatePayload } from "../../../scripts/smoke-pages-validation.mjs";

test("Pages smoke validation accepts the initial zero projection revision", () => {
  assert.equal(isValidCandidatePayload({ items: [], revision: 0 }), true);
  assert.equal(isValidCandidatePayload({ items: [], revision: -1 }), false);
  assert.equal(isValidCandidatePayload({ items: [], revision: "0" }), false);
});
