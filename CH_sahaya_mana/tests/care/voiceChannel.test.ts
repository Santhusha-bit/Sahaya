import { describe, expect, it } from "vitest";
import { careWorld, margaret } from "./careHelpers";

describe("Care voice channel follows the real voice provider", () => {
  it("records prompts as simulated when voice is sandbox", async () => {
    const w = await careWorld();
    w.clock.advanceMinutes(5);
    await w.care.tick(margaret);
    const [u] = await w.services().env.repo.voiceLog(margaret.userId);
    expect(u).toMatchObject({ channelMode: "sandbox", simulated: true });
    const d = await w.care.getDashboard(margaret);
    expect(d.integrations.find((i) => i.integration === "voice")).toMatchObject({ mode: "sandbox" });
  });

  it("uses the live app channel (Cartesia playback, no calls) when voice is live", async () => {
    const w = await careWorld({ modes: { voice: "live", cartesia: "live" } });
    w.clock.advanceMinutes(5);
    await w.care.tick(margaret);
    const [u] = await w.services().env.repo.voiceLog(margaret.userId);
    expect(u).toMatchObject({ channelMode: "live", simulated: false });
    const d = await w.care.getDashboard(margaret);
    expect(d.integrations.find((i) => i.integration === "voice")).toMatchObject({ mode: "live", detail: expect.stringMatching(/no phone calls/) });
  });
});
