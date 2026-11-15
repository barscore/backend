/**
 * Who to write to first: PRs that still have presales (or never said how
 * many), the nearest first; the ones who sold out last. Stable otherwise.
 */
export function sortPrs(prs) {
  const soldOut = (pr) => (pr.presales_available === 0 ? 1 : 0);
  const far = (pr) => pr.distance_km ?? Infinity;
  return [...prs].sort((a, b) => soldOut(a) - soldOut(b) || (far(a) === far(b) ? 0 : far(a) - far(b)));
}
