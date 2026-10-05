// "Seen by X of Y" — pure rules, shared by the server routes and the UI.
//
// "SEEN" MEANS THE PERSON'S SCREEN SHOWED THAT POST. It is evidence the client
// reports as posts come into view (see components/juice-box/seen-report.ts), kept
// in team_message_seen — one row per (post, person), written only for posts
// actually reached.
//
// IT IS DELIBERATELY NOT DERIVED FROM THE READ MARKERS. The per-channel marker
// (`last_read_at`) answers "is anything newer than here unread?", and it is
// stamped with the database's now() the moment someone lands at the newest post.
// On a first open the feed has loaded 50 posts, but that write also passes every
// older post that was never loaded — and any post created between the feed fetch
// and the write. Fine for the unread badge and the NEW MESSAGES divider; wrong for
// "this person saw THIS post". The two concepts are independent: nothing here
// reads or changes a marker, and nothing about unread depends on this.
//
//     a person has SEEN a post  ⇔  they wrote it, OR a receipt exists for them on it.
//
//   * A REPLY is its own post with its own receipts; it does not inherit its
//     parent's. Moving a conversation between channels doesn't change anything —
//     receipts belong to the post, not the channel.
//   * Pagination can't create a false "seen": loading older posts reports nothing;
//     only posts actually shown on screen are reported.
//   * Posts from before this feature shipped have no receipts, so they read as not
//     seen by anyone but their author — honest, since nothing proves otherwise.
//
// AUDIENCE of a post = every ACTIVE, NON-TEST salesperson who could see Juice Box
// (all roles — Juice Box is open to the whole team and has no per-channel
// membership) and who was on the team when the post was written. Someone whose
// account was created AFTER a post was not expected to see it. The author counts
// as seen.

export type SeenPerson = { id: string; name: string };

/** A member of the possible audience. `joined_at` = salespeople.created_at. */
export type AudienceMember = SeenPerson & { joined_at: string | null };

/** The slice of a post this math needs. */
export type SeenPost = {
  id: string;
  created_at: string;
  salesperson_id: string;
};

/** post id -> the people with a "reached this post" receipt on it. */
export type ReceiptIndex = Map<string, ReadonlySet<string>>;

/** Whether `member` was on the team when `post` was written (or wrote it). */
function inAudience(member: AudienceMember, post: SeenPost): boolean {
  if (member.id === post.salesperson_id) return true;
  if (!member.joined_at) return true;
  const joined = Date.parse(member.joined_at);
  const written = Date.parse(post.created_at);
  if (Number.isNaN(joined) || Number.isNaN(written)) return true;
  return joined <= written;
}

export type SeenResult = {
  seen: SeenPerson[];
  not_seen: SeenPerson[];
};

const byName = (a: SeenPerson, b: SeenPerson) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
  a.id.localeCompare(b.id);

/** Splits the post's audience into who has and hasn't seen it. */
export function seenResultFor(
  post: SeenPost,
  audience: readonly AudienceMember[],
  receipts: ReceiptIndex,
): SeenResult {
  const reached = receipts.get(post.id);
  const seen: SeenPerson[] = [];
  const not_seen: SeenPerson[] = [];
  for (const member of audience) {
    if (!inAudience(member, post)) continue;
    const person = { id: member.id, name: member.name };
    const saw = member.id === post.salesperson_id || reached?.has(member.id) === true;
    (saw ? seen : not_seen).push(person);
  }
  seen.sort(byName);
  not_seen.sort(byName);
  return { seen, not_seen };
}

/** What each post shows inline — counts only, never names. */
export type SeenSummary = { seen: number; total: number };

/** What the detail sheet shows. Names are returned ONLY to authorized callers. */
export type SeenDetail = SeenSummary & {
  id: string;
  seen_people: SeenPerson[];
  not_seen_people: SeenPerson[];
};

export type SeenSummariesResponse = { posts: Record<string, SeenSummary> };

export const seenLabel = (s: SeenSummary) => `Seen by ${s.seen} of ${s.total}`;

/** Max posts per summary request (one page of the feed is FEED_PAGE_SIZE = 50). */
export const SEEN_SUMMARY_MAX_IDS = 200;

/** Max posts per "I reached these" report — mirrors juice_box_mark_seen's cap. */
export const SEEN_REPORT_MAX_IDS = 100;

// ---------------------------------------------------------------------------
// What counts as "reached" on the client
// ---------------------------------------------------------------------------

/** Held in view this long before it counts — a post flicking past mid-scroll doesn't. */
export const SEEN_DWELL_MS = 500;

/**
 * IntersectionObserver thresholds. An observer only re-evaluates a post when its
 * visible RATIO crosses one of these, and `isReached` has a second path for posts
 * taller than the screen (visible part fills half the viewport). For such a post
 * that happens at ratio ≈ 0.5 × viewport / height, which the coarse
 * [0, .25, .5, .75, 1] list never crosses once the post is taller than ~2
 * screens — the post would be on screen and never evaluated.
 *
 * A step of 0.02 guarantees a crossing between (viewport/height)/2 and
 * viewport/height, i.e. for any post up to 25 screens tall (a 1,000-character
 * message with ten images is a handful of screens).
 */
export const SEEN_THRESHOLDS: number[] = Array.from({ length: 51 }, (_, i) =>
  Math.round(i * 2) / 100,
);

/** The fields of an IntersectionObserverEntry the rule needs. */
export type ViewportEntry = {
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: { height: number };
  rootBounds: { height: number } | null;
};

/**
 * Whether a post is on screen enough to count: at least half of it is visible, OR
 * the visible part fills at least half the viewport (a long post can never reach
 * 50% of ITSELF while it is taller than the screen, but reading its middle is
 * clearly reaching it).
 */
export function isReached(entry: ViewportEntry, viewportHeight: number): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= 0.5) return true;
  const root = entry.rootBounds?.height ?? viewportHeight;
  return root > 0 && entry.intersectionRect.height >= root * 0.5;
}
