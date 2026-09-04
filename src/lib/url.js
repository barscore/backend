// Keep only well-formed http(s) URLs; anything else (javascript:, data:,
// malformed OSM tags) becomes null. Used at the /bars/resolve insert instead of
// schema-level .url() because raw OSM tags are frequently malformed and a bad
// tag must not reject the whole bar.
export function sanitizeHttpUrl(v) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// --- self-check: `node src/lib/url.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const eq = (a, b, m) => {
    if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`);
  };
  eq(sanitizeHttpUrl('https://bar.example/x'), 'https://bar.example/x', 'https passes');
  eq(sanitizeHttpUrl('  http://bar.example/  '), 'http://bar.example/', 'http passes, trimmed');
  eq(sanitizeHttpUrl('javascript:alert(1)'), null, 'javascript: dropped');
  eq(sanitizeHttpUrl('data:text/html,<script>'), null, 'data: dropped');
  eq(sanitizeHttpUrl('www.bar.example'), null, 'malformed string ⇒ null');
  eq(sanitizeHttpUrl(''), null, 'empty string ⇒ null');
  eq(sanitizeHttpUrl(null), null, 'non-string ⇒ null');
  eq(sanitizeHttpUrl(42), null, 'non-string ⇒ null');
  console.log('url self-check ok');
}
