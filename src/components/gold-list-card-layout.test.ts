/**
 * Layout contract for the Gold List agent card.
 *
 * WHY THIS IS A SOURCE TEST AND NOT A RENDER TEST
 *   This project has no jsdom / testing-library setup and the brief forbids
 *   new dependencies, so a card cannot be mounted in Vitest. What CAN be
 *   pinned down is the contract the compact redesign rests on — the classes
 *   and attributes that carry it. Each assertion below maps to a requirement
 *   whose regression would be silent: text quietly dropping back to 12px, the
 *   dashed empty-state box returning, a tap target shrinking, or the history
 *   disclosure losing its keyboard/ARIA behaviour.
 *
 *   The rendered result was verified separately in headless Chrome at 320px,
 *   375px and desktop widths; these tests are the guard that keeps it that
 *   way. They are deliberately written against stable, meaningful strings
 *   rather than whole class lists, so ordinary restyling does not trip them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const card = readFileSync(join(here, "gold-list-agent-card.tsx"), "utf8");
const board = readFileSync(join(here, "gold-list-board.tsx"), "utf8");

describe("agent card — density", () => {
  it("has dropped the dashed empty-state box", () => {
    // The old "No next activity" container was a bordered dashed block that
    // cost ~60px of card height to hold one sentence and one button.
    expect(card).not.toMatch(/border-dashed/);
  });

  it("renders the no-activity status and its action as one wrapping row", () => {
    expect(card).toMatch(
      /flex flex-wrap items-center justify-between[^"]*">\s*<p className="text-base font-medium[^"]*">\s*No next activity/,
    );
  });

  it("does not impose a fixed card height", () => {
    expect(card).not.toMatch(/<Card[^>]*height=/);
  });

});

/** The contact row's JSX, from its conditional to the closing `: null}`. */
function contactBlock(): string {
  const start = card.indexOf('(agent.phone || agent.email) && mode !== "edit"');
  expect(start).toBeGreaterThan(-1);
  // Ends where the next block begins — the inner phone/email conditionals each
  // close with their own `) : null}`, so that is not a usable boundary.
  const end = card.indexOf("{historyOpen && agent.notes", start);
  expect(end).toBeGreaterThan(start);
  return card.slice(start, end);
}

describe("agent card — contact row", () => {
  it("shows contact on the COLLAPSED card, not behind Details & history", () => {
    // A collapsed card must answer "how do I reach them" without a tap. The
    // row is gated only on there being something to show and on the edit form
    // being closed — NOT on historyOpen.
    expect(card).toMatch(
      /\(agent\.phone \|\| agent\.email\) && mode !== "edit" \? \(/,
    );
    expect(card).not.toMatch(/agent\.email\) && historyOpen/);
  });

  it("renders no row at all when there is neither a phone nor an email", () => {
    // The whole block is inside the conditional, so a contactless agent gets
    // no element, no placeholder text and no extra gap.
    expect(card).toMatch(
      /\(agent\.phone \|\| agent\.email\) && mode !== "edit" \? \([\s\S]{0,2000}?\) : null\}/,
    );
  });

  it("keeps the phone a tel: link and the email a mailto: link", () => {
    expect(card).toContain("href={goldListPhoneHref(agent.phone)}");
    expect(card).toContain("href={goldListEmailHref(agent.email)}");
  });

  it("uses the existing phone and mail icons, hidden from screen readers", () => {
    expect(card).toMatch(/<Phone aria-hidden="true"/);
    expect(card).toMatch(/<Mail aria-hidden="true"/);
  });

  it("gives each link an accessible name that says what it does", () => {
    expect(card).toMatch(
      /aria-label=\{`Call \$\{agent\.agent_name\} at \$\{agent\.phone\}`\}/,
    );
    expect(card).toMatch(
      /aria-label=\{`Email \$\{agent\.agent_name\} at \$\{agent\.email\}`\}/,
    );
  });

  it("renders contact text at 16px", () => {
    expect(card).toMatch(
      /\(agent\.phone \|\| agent\.email\) && mode !== "edit" \? \(\s*<div className="[^"]*text-base/,
    );
  });

  it("keeps a 44px target and a visible keyboard focus ring on each link", () => {
    // The card-level rule is what sizes the targets without padding boxes.
    expect(card).toMatch(/\[&_a\]:min-h-11/);
    // Both links inside the contact block carry their own focus ring.
    const block = contactBlock();
    expect(block.match(/focus-visible:outline-2/g)).toHaveLength(2);
    expect(block.match(/focus-visible:outline-primary/g)).toHaveLength(2);
  });

  it("wraps rather than shrinking or overflowing", () => {
    expect(card).toMatch(
      /\(agent\.phone \|\| agent\.email\) && mode !== "edit" \? \(\s*<div className="flex flex-wrap/,
    );
    // The long-address case breaks inside the card instead of widening it.
    expect(card).toMatch(/<span className="break-all">\{agent\.email\}<\/span>/);
  });

  it("does not duplicate the links as plain text elsewhere", () => {
    // Exactly one tel: and one mailto: in the component.
    expect(card.match(/href=\{goldListPhoneHref/g)).toHaveLength(1);
    expect(card.match(/href=\{goldListEmailHref/g)).toHaveLength(1);
  });
});

describe("agent card — typography and contrast", () => {
  it("gives the agent name the only 20px line on the card", () => {
    expect(card).toMatch(
      /text-xl font-semibold[^"]*">\s*\{agent\.agent_name\}/,
    );
  });

  it("never falls back to 12px text", () => {
    // 14px (`text-sm`) is the floor, and only for tertiary stamps.
    expect(card).not.toMatch(/text-xs/);
  });

  it("sets the activity description at 16px and its note at 15px", () => {
    expect(card).toMatch(
      /text-base font-medium leading-snug">\s*<CalendarClock/,
    );
    expect(card).toMatch(
      /activity\.activity_note \? \(\s*<p className="[^"]*text-\[0\.9375rem\]/,
    );
  });

  it("keeps secondary text on a brighter mix than muted-foreground", () => {
    // muted-foreground (#9aa4b2) reads faint at small sizes on the dark card;
    // the card's secondary text uses foreground/70–80 instead.
    expect(card).toMatch(/text-foreground\/80/);
    expect(card).not.toMatch(/text-xs text-muted-foreground/);
  });

  it("lets long notes and descriptions wrap instead of clipping", () => {
    expect(card).toMatch(
      /activity\.activity_note[\s\S]{0,200}whitespace-pre-wrap break-words/,
    );
    expect(card).toMatch(/\[overflow-wrap:anywhere\]/);
  });

  it("stacks the activity text above its actions on phones", () => {
    // Sharing the row squeezed short descriptions into a ~90px column.
    expect(card).toMatch(/min-w-0 flex-1 basis-full sm:basis-auto/);
  });
});

describe("agent card — touch targets and accessibility", () => {
  it("floors every control in the card at 44px", () => {
    expect(card).toMatch(/\[&_button\]:min-h-11/);
    expect(card).toMatch(/\[&_button\]:min-w-11/);
    expect(card).toMatch(/\[&_a\]:min-h-11/);
  });

  it("names the edit and archive controls for screen readers", () => {
    expect(card).toMatch(/aria-label=\{`Edit \$\{agent\.agent_name\}`\}/);
    expect(card).toMatch(/Archive \$\{agent\.agent_name\}/);
    expect(card).toMatch(/Restore \$\{agent\.agent_name\}/);
  });

  it("still confirms before archiving", () => {
    expect(card).toMatch(
      /window\.confirm\(\s*`Archive \$\{agent\.agent_name\}/,
    );
  });

  it("makes the whole Details & history row the control", () => {
    // Full width, label and summary inside the button, chevron pushed to the
    // far edge — not a precise tap on a 14px chevron.
    expect(card).toMatch(
      /flex w-\[calc\(100%\+1rem\)\] items-center justify-between/,
    );
    expect(card).toMatch(/aria-expanded=\{historyOpen\}/);
    expect(card).toMatch(/focus-visible:ring-2 focus-visible:ring-primary/);
  });

  it("keeps the history row readable at 16px with its count and last date", () => {
    expect(card).toMatch(/text-base font-medium text-foreground\/90/);
    expect(card).toMatch(
      /Details &amp; history \(\{agent\.completed_count\}\)/,
    );
    expect(card).toMatch(
      /· Last \{formatDateMDY\(agent\.last_completed_on\)\}/,
    );
  });

  it("preserves lazy history loading and its loading + error states", () => {
    expect(card).toMatch(/historyLoading \? \(/);
    expect(card).toMatch(/role="alert"/);
    expect(card).toMatch(/if \(!opening \|\| history !== null\) return;/);
  });
});

describe("agent card — workflow left intact", () => {
  it("still offers add, edit, complete, cancel and archive", () => {
    for (const label of [
      "Add Activity",
      "Complete",
      "Cancel this activity",
      "Schedule an activity",
      "Edit activity",
    ]) {
      expect(card).toContain(label);
    }
  });

  it("still gates every write affordance on the server's can_edit", () => {
    expect(card).toMatch(/const canEdit = agent\.can_edit;/);
    expect(card).toMatch(/\{canEdit \? \(/);
  });
});

describe("board — Show archived control", () => {
  it("is 16px, tappable and has hover/focus/pressed styling", () => {
    expect(board).toMatch(
      /aria-expanded=\{showArchived\}[\s\S]{0,400}text-base font-medium/,
    );
    expect(board).toMatch(
      /aria-expanded=\{showArchived\}[\s\S]{0,600}focus-visible:ring-2/,
    );
    expect(board).toMatch(/aria-expanded:text-foreground/);
  });

  it("decides the owner line from the server-issued scope", () => {
    expect(board).toMatch(
      /showOwner=\{data \? shouldShowOwnerLine\(data\.scope, agent\) : false\}/,
    );
  });
});
