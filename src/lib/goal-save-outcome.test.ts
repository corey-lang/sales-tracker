import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GOAL_NOT_RECORDED_MESSAGE,
  interpretGoalSaveResponse,
} from "@/lib/goal-save-outcome";

const respond = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("interpretGoalSaveResponse — when the goal editor may say \"Saved\"", () => {
  it("inside a 1:1, a 409 (completed / completing) is an error and never \"Saved\"", async () => {
    const out = await interpretGoalSaveResponse(
      respond(409, { error: "This 1:1 is completed and read-only." }),
      true,
    );
    expect(out).toEqual({ saved: false, error: "This 1:1 is completed and read-only.", resync: false });
  });

  it("inside a 1:1, a 200 WITHOUT recorded_in_meeting:true is NOT \"Saved\" (and asks for a re-sync)", async () => {
    for (const body of [{ recorded_in_meeting: false }, {}, undefined, { recorded_in_meeting: "true" }]) {
      const out = await interpretGoalSaveResponse(respond(200, body), true);
      expect(out).toEqual({ saved: false, error: GOAL_NOT_RECORDED_MESSAGE, resync: true });
    }
  });

  it("inside a 1:1, a 200 with recorded_in_meeting:true is saved", async () => {
    expect(await interpretGoalSaveResponse(respond(200, { recorded_in_meeting: true }), true)).toEqual({ saved: true });
  });

  it("outside a 1:1 nothing is recorded, so a plain 200 is saved exactly as before", async () => {
    expect(await interpretGoalSaveResponse(respond(200, { recorded_in_meeting: false }), false)).toEqual({ saved: true });
    expect(await interpretGoalSaveResponse(respond(200, {}), false)).toEqual({ saved: true });
  });

  it("an error without a JSON body falls back to a status message", async () => {
    const out = await interpretGoalSaveResponse(respond(502, undefined), false);
    expect(out).toEqual({ saved: false, error: "Couldn't save (502).", resync: false });
  });
});

describe("goal editor wiring", () => {
  it("only shows \"Saved\" after the outcome check (no other setSaved(true) path)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/admin/coaching/[ae_id]/_components/goal-editor.tsx"),
      "utf8",
    );
    expect(src).toContain("interpretGoalSaveResponse(res, Boolean(meetingId))");
    expect(src.match(/setSaved\(true\)/g)).toHaveLength(1);
    // The one call sits after the outcome check and its early return.
    expect(src.indexOf("setSaved(true)")).toBeGreaterThan(src.indexOf("if (!outcome.saved)"));
    expect(src).not.toMatch(/if \(!res\.ok\)/);
  });
});
