import type { Metadata } from "next";
import { DraftPage } from "../(legal)/DraftPage";
import { DEMO_URL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Contact (Draft) | Sahaya",
  robots: { index: false },
};

export default function ContactPage() {
  return (
    <DraftPage title="Contact">
      <p className="text-sm font-medium text-faint">
        Draft for review. Last updated October 2026.
      </p>

      <p>
        Sahaya is built by a small team of students and builders who care about
        helping older adults live safely and independently, and about giving their
        families peace of mind. We would love to hear from you.
      </p>

      <h2 className="h3 pt-6 text-ink">Who we help</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <span className="font-semibold text-ink">Older adults</span> curious
          about using Sahaya as a daily companion.
        </li>
        <li>
          <span className="font-semibold text-ink">Families and caregivers</span>{" "}
          who want to stay connected and informed, with permission.
        </li>
        <li>
          <span className="font-semibold text-ink">
            Partners and researchers
          </span>{" "}
          interested in safe, respectful AI for aging well.
        </li>
      </ul>

      <h2 className="h3 pt-6 text-ink">Try the live demo</h2>
      <p>
        The fastest way to understand Sahaya is to see it in action. Our
        interactive demo shows the Guardian, Care, Wellness, and Finance
        experiences working together.
      </p>
      <p>
        <a href={DEMO_URL} className="font-semibold text-brand-ink underline">
          Open the Sahaya demo
        </a>
      </p>

      <h2 className="h3 pt-6 text-ink">Get in touch</h2>
      <p>
        A dedicated support email and contact form will be added here before any
        public release. In the meantime, if you reached this project through a
        demo, event, or showcase, please use the channel you were given there.
      </p>

      <h2 className="h3 pt-6 text-ink">In an emergency</h2>
      <p>
        This page is not monitored for emergencies. If you or someone you care for
        needs urgent help, always call your local emergency number first. Sahaya
        can help coordinate and notify trusted contacts, but it does not replace
        emergency responders.
      </p>

      <p className="pt-2 text-sm text-faint">
        This is a draft page. A full set of contact options will be published with
        the final release.
      </p>
    </DraftPage>
  );
}
