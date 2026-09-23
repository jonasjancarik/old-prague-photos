export function isValidReviewSnapshot(payload) {
  return (
    payload?.reviewStateSchemaVersion === 4 &&
    Array.isArray(payload?.groupCorrections) &&
    Array.isArray(payload?.doneGroupIds) &&
    Array.isArray(payload?.mergeDecisions) &&
    payload?.resolvedGroupByXid !== null &&
    typeof payload?.resolvedGroupByXid === "object" &&
    Number.isSafeInteger(payload?.counts?.knownXids) &&
    payload.counts.knownXids > 0
  );
}
