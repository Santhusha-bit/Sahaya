import type { Metadata } from "next";
import { DraftPage } from "../(legal)/DraftPage";

export const metadata: Metadata = {
  title: "Privacy (Draft) | Sahaya",
  robots: { index: false },
};

export default function PrivacyPage() {
  return (
    <DraftPage title="Privacy Policy">
      <p className="text-sm font-medium text-faint">
        Draft for review. Last updated October 2026.
      </p>

      <p>
        Sahaya is an AI companion built for older adults and the families who
        care about them. Because the people who use Sahaya share some of the most
        personal parts of their lives with it, privacy is not a feature we added
        later. It is the foundation the product is built on. This draft explains
        what Sahaya collects, how that information is used, and the control the
        user keeps over all of it.
      </p>

      <h2 className="h3 pt-6 text-ink">Our core principle</h2>
      <p>
        The older adult who uses Sahaya owns their data. They decide what is
        remembered, what is shared, and with whom. Family members and caregivers
        receive information only through permissions the user has explicitly
        granted, and those permissions can be changed or withdrawn at any time.
      </p>

      <h2 className="h3 pt-6 text-ink">Information we collect</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <span className="font-semibold text-ink">Conversations.</span> Voice and
          text exchanges with Sahaya, so it can understand requests, respond, and
          remember what matters to the user.
        </li>
        <li>
          <span className="font-semibold text-ink">Wellness observations.</span>{" "}
          Self-reported notes about sleep, energy, appetite, mood, and routine
          that the user chooses to share in conversation. These are
          conversational observations, not clinical measurements.
        </li>
        <li>
          <span className="font-semibold text-ink">Care details.</span> Medication
          schedules, grocery and meal preferences, and reminders the user sets up.
        </li>
        <li>
          <span className="font-semibold text-ink">Financial information.</span>{" "}
          Bills, invoices, and account details the user provides or authorizes
          Sahaya to review for its Finance features.
        </li>
        <li>
          <span className="font-semibold text-ink">Trusted contacts.</span> Family
          members, caregivers, and emergency contacts the user adds, along with
          their chosen sharing permissions.
        </li>
        <li>
          <span className="font-semibold text-ink">Device and usage data.</span>{" "}
          Basic technical information needed to run the service reliably and keep
          it secure.
        </li>
      </ul>

      <h2 className="h3 pt-6 text-ink">How we use information</h2>
      <p>
        Information is used to deliver the features the user has asked for: to
        answer and assist in conversation, deliver medication and appointment
        reminders, recognize suspicious or scam-like requests, review bills and
        flag possible issues, notice meaningful changes in self-reported
        well-being, and coordinate help from trusted contacts. Sahaya does not
        sell personal information.
      </p>

      <h2 className="h3 pt-6 text-ink">Sharing with family and caregivers</h2>
      <p>
        Wellness summaries, activity, and alerts are shared with family or
        caregivers only with the user&apos;s consent. The user controls each
        permission individually and can review, change, or revoke what is shared
        at any time. Emergency notifications follow the escalation preferences the
        user has set up in advance.
      </p>

      <h2 className="h3 pt-6 text-ink">How each agent handles data</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <span className="font-semibold text-ink">Guardian</span> processes
          interactions to recognize scams and coordinate emergency help. It does
          not take protective or financial action on the user&apos;s behalf
          without their involvement.
        </li>
        <li>
          <span className="font-semibold text-ink">Care</span> stores medication
          and shopping preferences to prepare reminders and draft requests.
          Purchases always require the user&apos;s authorization.
        </li>
        <li>
          <span className="font-semibold text-ink">Wellness</span> keeps a
          personalized memory of self-reported observations to notice patterns
          over time. Summaries reach family only with permission.
        </li>
        <li>
          <span className="font-semibold text-ink">Finance</span> reviews only the
          financial data the user authorizes and never moves money or submits a
          dispute on its own.
        </li>
      </ul>

      <h2 className="h3 pt-6 text-ink">Service providers</h2>
      <p>
        Sahaya relies on trusted technology providers for AI processing, secure
        storage, and communication. These providers process information only to
        operate the service and are expected to protect it with appropriate
        safeguards. A full list of processors will accompany the released policy.
      </p>

      <h2 className="h3 pt-6 text-ink">Your controls</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>Review what Sahaya remembers about you.</li>
        <li>Correct or delete information, including specific memories.</li>
        <li>Change or revoke family-sharing permissions at any time.</li>
        <li>Request a copy of your data or close your account.</li>
      </ul>

      <h2 className="h3 pt-6 text-ink">Security and retention</h2>
      <p>
        Information is protected with technical and organizational safeguards and
        kept only as long as needed to provide the service or as required by law.
        When data is no longer needed, it is deleted or de-identified.
      </p>

      <h2 className="h3 pt-6 text-ink">Who Sahaya is for</h2>
      <p>
        Sahaya is designed for adults. It is not directed to children, and we do
        not knowingly collect information from anyone under 18.
      </p>

      <h2 className="h3 pt-6 text-ink">Changes and contact</h2>
      <p>
        A complete privacy policy will be published, and reviewed by qualified
        advisers, before any public release. Until then this draft reflects our
        intended approach. For questions, please use the contact page.
      </p>

      <p className="pt-2 text-sm text-faint">
        This is a draft for transparency and does not yet constitute a legally
        binding privacy policy.
      </p>
    </DraftPage>
  );
}
