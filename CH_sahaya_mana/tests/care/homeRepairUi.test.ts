import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingConfirmation, HomeRepairHelp, type HomeRepairOwnerView } from "@/components/care/HomeRepairHelp";
import { FORBIDDEN_META } from "@/agents/care/domain/homeRepairReply";

const base: HomeRepairOwnerView = { pending: null, openRequest: null, changeTimes: [], bookings: [], audit: [] };
const html = (view: HomeRepairOwnerView) => renderToStaticMarkup(createElement(HomeRepairHelp, { view, onChanged: async () => undefined }));
const booking = { bookingId: "hsb_1", title: "Plumber booked", service: "plumbing" as const, issue: "Kitchen sink leaking", provider: "Bayside Plumbing Co.", arrivalWindow: "Tomorrow, 9–11 am", reference: "GD-AB12-CD34", status: "Booked", statusCode: "booked" as const, estimate: "$150.00" };

describe("home repair UI", () => {
  it("before anything is chosen: no booking wording at all", () => {
    const out = html(base);
    expect(out).toContain("Need something fixed at home?");
    expect(out).not.toMatch(/booked|Reference|Approve/);
  });

  it("safety steps first, then 'I can arrange this' with time choices (no approval or booking yet)", () => {
    const out = html({ ...base, openRequest: { requestId: "hsr_1", service: "plumbing", issue: "Kitchen sink leaking", safety: { emergency: false, steps: ["If it's safe, turn off the valve under the sink or toilet, or the main water shutoff."] }, timeWindows: [{ windowId: "win_2026-10-27_09", label: "Tomorrow, 9–11 am" }, { windowId: "win_2026-10-27_12", label: "Tomorrow, 12–2 pm" }] } });
    expect(out.indexOf("turn off the valve")).toBeLessThan(out.indexOf("I can arrange this for you"));
    expect(out).toContain("Tomorrow, 12–2 pm");
    expect(out).not.toMatch(/booked|Approve/);
  });

  it("approval card: service, issue, time, provider and cost with Approve / Change time / Decline", () => {
    const out = html({ ...base, pending: { proposalId: "hsp_1", requestId: "hsr_1", approvalId: "apr_1", service: "plumbing", issue: "Kitchen sink leaking", time: "Tomorrow, 9–11 am", provider: "Bayside Plumbing Co.", cost: "$150.00" } });
    for (const s of ["Service: ", "Plumbing", "Issue: ", "Kitchen sink leaking", "Time: ", "Tomorrow, 9–11 am", "Provider: ", "Bayside Plumbing Co.", "Estimated cost: ", "$150.00", ">Approve<", ">Change time<", ">Decline<"]) expect(out).toContain(s);
    expect(out).not.toMatch(/Plumber booked|Reference/);
  });

  it("confirmation card after approval: title, provider, arrival window, reference and the status steps", () => {
    const out = renderToStaticMarkup(createElement(BookingConfirmation, { b: { ...booking, statusCode: "on_the_way", status: "On the way" } }));
    for (const s of ["Plumber booked", "Bayside Plumbing Co.", "Tomorrow, 9–11 am", "GD-AB12-CD34", "Booked", "On the way", "Done"]) expect(out).toContain(s);
    expect(out).toMatch(/aria-current="step"[^>]*>On the way/);
  });

  it("no meta words anywhere in the UI", () => {
    const views = [base, { ...base, bookings: [booking] }, { ...base, pending: { proposalId: "p", requestId: "r", approvalId: "a", service: "plumbing" as const, issue: "x", time: "t", provider: "Bayside Plumbing Co.", cost: "$1.00" } }];
    for (const v of views) expect(html(v)).not.toMatch(FORBIDDEN_META);
  });
});
