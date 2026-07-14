export function isValidCandidatePayload(payload) {
  return (
    Array.isArray(payload?.items) &&
    Number.isSafeInteger(payload?.revision) &&
    payload.revision >= 0
  );
}
