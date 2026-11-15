function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { return { format: 'NewsML-G2', package: /<packageItem\b/.test(bytes.toString()), sourceBytes: bytes.length }; }
