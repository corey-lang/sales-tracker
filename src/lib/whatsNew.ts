/**
 * "What's New" feature feed — V1 content source.
 *
 * Hardcoded on purpose: V1 is a simple, in-app training feed that helps AEs
 * discover and learn recently-shipped features. No backend, read-tracking,
 * CMS, analytics, or notifications — just a typed list rendered as cards on
 * /settings/whats-new. To announce a feature, add an entry here (newest first).
 *
 * Tone: conversational and encouraging ("this helps you succeed"), never
 * changelog/version-notes wording.
 */

export type WhatsNewItem = {
  /** Stable slug — also used as the React key. */
  id: string;
  /** Emoji shown in the card header. */
  icon: string;
  title: string;
  /** ISO calendar day (YYYY-MM-DD); formatted for display in the page. */
  releasedAt: string;
  /** Plain-language "here's what it is". */
  whatItDoes: string;
  /** The AE payoff — why they should care. */
  whyItMatters: string;
  /** Short, friendly steps. Rendered as a numbered list. */
  howToUseIt: string[];
  /** Optional encouraging tip. */
  proTip?: string;
  /** Show the NEW badge for recently-shipped items. */
  isNew?: boolean;
};

/** Newest first — the page renders them in this order. */
export const WHATS_NEW: WhatsNewItem[] = [
  {
    id: "orders",
    icon: "🏠",
    title: "Orders",
    releasedAt: "2026-06-04",
    isNew: true,
    whatItDoes:
      "Right on your Home screen, you can now see your production orders for the month, how today is going, and whether you're on track to hit your monthly goal.",
    whyItMatters:
      "No more guessing where you stand. One glance tells you if you're ahead or behind, so you can adjust your week while there's still time to make it count.",
    howToUseIt: [
      "Open Home — the 🏠 Orders card sits right at the top.",
      "“Orders this month” shows your month-to-date count next to your goal.",
      "“Today” counts the new orders that have landed so far today — it starts at 0 each morning and climbs as orders come in 🎉.",
      "“Pace” compares where you are to where you should be by this point in the month.",
    ],
    proTip:
      "100% pace means you're exactly on track for your monthly goal based on the business days that have passed. Above 100% you're ahead; below 100% it's time to push. Try to stay at or above 100% all month long.",
  },
  {
    id: "office-map",
    icon: "🗺️",
    title: "Office Map & Visit Tracking",
    releasedAt: "2026-05-20",
    isNew: true,
    whatItDoes:
      "All your offices live on a map now, so you can plan your day, find who's nearby, log visits, and keep notes and next steps for every office in one place.",
    whyItMatters:
      "Spend less time figuring out where to go and more time in front of people. Everything you need to know about an office is right there when you walk in.",
    howToUseIt: [
      "Open the Map to see your offices as pins around you.",
      "Tap “Nearby” to plan an efficient route based on where you are right now.",
      "Use Lasso Select to circle a cluster of offices and work them as a group.",
      "Tap any office to log a visit, jot a quick note, or set a Next Action with a due date.",
    ],
    proTip:
      "Set a Next Action every time you leave an office — even something small like “drop donuts Friday.” Future-you will thank you.",
  },
  {
    id: "lasso-select",
    icon: "🪢",
    title: "Lasso Select",
    releasedAt: "2026-05-20",
    isNew: true,
    whatItDoes:
      "Draw a circle around a group of offices on the map and select them all at once.",
    whyItMatters:
      "Planning a day in one neighborhood? Grab the whole cluster in a single gesture instead of tapping pins one by one.",
    howToUseIt: [
      "On the Map, tap the Lasso tool.",
      "Draw a loop around the offices you want.",
      "Everything inside the loop is selected — there's your route for the day.",
    ],
    proTip:
      "Lasso a tight cluster first thing in the morning to build a quick, walkable route.",
  },
  {
    id: "next-actions",
    icon: "✅",
    title: "Next Actions & Follow-Ups",
    releasedAt: "2026-04-28",
    whatItDoes:
      "Turns “I should follow up with them” into a real reminder. Set a next step on any office, or add a standalone to-do.",
    whyItMatters:
      "The follow-up is where deals are won. Keep every commitment in one list so nothing slips through the cracks.",
    howToUseIt: [
      "On an office, set a Next Action and an optional due date.",
      "Open your To-Dos to see everything coming up.",
      "Tap “Also add to my To-Dos” to keep office follow-ups alongside the rest of your tasks.",
      "Check them off as you go.",
    ],
    proTip:
      "End each day by clearing your To-Dos and setting tomorrow's first follow-up — you'll start the morning with a plan instead of a blank slate.",
  },
  {
    id: "business-card-scanner",
    icon: "📇",
    title: "Business Card Scanner",
    releasedAt: "2026-04-15",
    whatItDoes:
      "Snap a photo of a business card and the app pulls out the name, company, phone, and email for you.",
    whyItMatters:
      "Never lose a lead in a stack of cards again. Capture the contact on the spot and keep moving.",
    howToUseIt: [
      "Tap Scan Business Card and take a photo of the card.",
      "Review the details the app pulled out and fix anything that needs a tweak.",
      "Save it — or add it straight to your phone contacts.",
    ],
    proTip:
      "Scan cards right after a conversation while it's fresh, and add a quick note about what you talked about.",
  },
  {
    id: "juice-box",
    icon: "🧃",
    title: "Juice Box",
    releasedAt: "2026-03-10",
    whatItDoes:
      "The team's space to share wins, photos, and updates — and cheer each other on.",
    whyItMatters:
      "Selling is more fun together. Celebrate big orders, swap tips, and stay connected with the whole team in one feed.",
    howToUseIt: [
      "Open Juice Box from the bottom nav.",
      "Post an update or photo, or react to a teammate's win.",
      "Turn on notifications so you never miss a big moment.",
    ],
    proTip:
      "Give a teammate a shout-out when they close something big — a little recognition goes a long way.",
  },
];
