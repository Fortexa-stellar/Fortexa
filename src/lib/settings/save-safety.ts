const SENSITIVE_FIELD =
  /secret|token|passphrase|password|private.?key|seed|mnemonic|api.?key|credential|session/i;

/** Reject unexpected sensitive keys before a settings payload can be saved. */
export function hasSensitiveField(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    for (const [key, child] of Object.entries(current)) {
      if (SENSITIVE_FIELD.test(key)) return true;
      pending.push(child);
    }
  }

  return false;
}
