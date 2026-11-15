// Keep comments, line endings and untouched fields intact while editing a form.
export function properties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#!\s][^=]*?)\s*=(.*)$/.exec(line);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

export function property(text: string, key: string, value: string) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let found = false;
  const output = lines.map((line) => {
    const match = /^(\s*)([^#!\s][^=]*?)(\s*=\s*)(.*)$/.exec(line);
    if (!match || match[2].trim() !== key) return line;
    found = true;
    return `${match[1]}${match[2]}${match[3]}${value}`;
  });
  if (!found) {
    if (output.at(-1) === "") output.pop();
    output.push(`${key}=${value}`, "");
  }
  return output.join(newline);
}

export function safeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeResult);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|password|secret|authorization|private.?key/i.test(key)
          ? "已隐藏"
          : safeResult(item),
      ]),
    );
  if (typeof value === "string")
    return value.replace(/(-t\s+\d+:)[^\s]+/gi, "$1***");
  return value;
}
