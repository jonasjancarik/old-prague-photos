function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

export function isMissingColumnError(error, columnNames = []) {
  const message = errorMessage(error).toLowerCase();
  const reportsMissingColumn =
    message.includes("no such column") ||
    message.includes("has no column named") ||
    message.includes("unknown column");
  if (!reportsMissingColumn) return false;
  if (!columnNames.length) return true;
  return columnNames.some((column) =>
    message.includes(String(column || "").toLowerCase()),
  );
}

export function logDatabaseError(endpoint, operation, error) {
  console.error(
    JSON.stringify({
      message: "D1 operation failed",
      endpoint,
      operation,
      error: errorMessage(error) || "Unknown error",
    }),
  );
}
