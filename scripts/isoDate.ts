// isoDate.ts — the ONE definition of "a commit date this tool will accept". Its own module because
// BOTH layers need it and they sit on opposite sides of the dependency edge: github.ts validates the
// dates entering from GitHub/git, and db.ts enforces the same shape at the run_unit_head write
// chokepoint. db.ts is the lower layer (github.ts imports it), so importing upward would invert that.
//
// A commit date is UNTRUSTED INPUT that silently steers scan SELECTION, which is why it earns real
// validation rather than a non-empty check. classifyBranchPlan compares `committedDate.slice(0, 10)`
// LEXICALLY against cutoffDate, so nothing downstream can catch a malformed value:
// "2025-99-99T99:99:99Z" simply sorts as if it were far in the future and the branch is silently
// classified ELIGIBLE (or, symmetrically, silently cutoff-skipped), and that same string then lands in
// the durable scanned_commit_date and the report's provenance.
//
// Validation is by EXPLICIT component ranges plus a day-of-month probe. `Date.parse` is deliberately
// NOT the range check, because it is not one — it silently NORMALIZES two forms this must reject, and
// normalization is precisely the laundering being guarded against:
//   - "2025-06-01T24:00:00Z" — hour 24 is a legal ISO end-of-day spelling, and Date.parse maps it to
//     00:00 on June 2. The stored string still slices to "2025-06-01", so the cutoff would compare a
//     DIFFERENT DAY than the instant denotes. Rejected: GitHub and `git show --format=%cI` emit 00-23.
//   - "2025-02-30T00:00:00Z" — an impossible calendar date, rolled over to March 2 rather than failing.
// So the explicit bounds catch what normalization would launder, and the day probe catches rollover
// (Feb 30, day 00, day 32) — including leap years, for free (2024-02-29 valid, 2025-02-29 not).
//
// Both judge the components AS WRITTEN, never the UTC projection: a legitimate offset date
// ("2025-06-01T02:00:00+05:00") lands on a different UTC day, so comparing toISOString() would reject
// genuine git output. Offset forms are accepted because %cI emits them; a leap second (:60) is
// rejected, as no producer feeding this emits one.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|[+-](\d{2}):(\d{2}))$/;

export function isIsoInstant(s: string): boolean {
  const m = ISO_INSTANT.exec(s);
  if (m === null) return false; // shape — also what makes the cutoff's slice(0, 10) meaningful
  const [, y, mo, d, h, mi, sec, oh, om] = m;
  const [Y, MO, D] = [Number(y), Number(mo), Number(d)];
  if (MO < 1 || MO > 12 || D < 1) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return false;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false; // undefined for the Z form
  const probe = new Date(Date.UTC(Y, MO - 1, D));
  // a rolled-over day (Feb 30 → Mar 2, day 32 → next month) returns different components than it got
  return probe.getUTCFullYear() === Y && probe.getUTCMonth() === MO - 1 && probe.getUTCDate() === D;
}
