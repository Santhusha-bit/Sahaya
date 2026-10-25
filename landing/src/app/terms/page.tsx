import type { Metadata } from "next";
import { DraftPage } from "../(legal)/DraftPage";

export const metadata: Metadata = {
  title: "Terms (Draft) | Sahaya",
  robots: { index: false },
};

export default function TermsPage() {
  return (
    <DraftPage title="Terms of Service">
      <p className="text-sm font-medium text-faint">
        Draft for review. Last updated October 2026.
      </p>

      <p>
        These draft terms describe how Sahaya is intended to work and the
        important limits on what it does. Sahaya is an assistive AI companion for
        older adults and their families. By using Sahaya, the user and their
        trusted contacts agree to use it as described here.
      </p>

      <h2 className="h3 pt-6 text-ink">What Sahaya is</h2>
      <p>
        Sahaya is a voice-first companion that helps older adults live safely,
        healthily, and more independently. It can help recognize scams, respond to
        emergencies by notifying trusted contacts, manage medication and grocery
        reminders, hold supportive conversations, notice changes in self-reported
        well-being, and review bills and financial tasks.
      </p>

      <h2 className="h3 pt-6 text-ink">What Sahaya is not</h2>
      <p>
        Sahaya is a supportive tool, not a replacement for professional judgment or
        human care. In particular, Sahaya is not:
      </p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>a medical device, and it does not diagnose, treat, or give medical advice;</li>
        <li>an emergency service, and it does not dispatch police, fire, or ambulance;</li>
        <li>a financial adviser, accountant, or legal professional; and</li>
        <li>a substitute for human caregivers, family, or qualified professionals.</li>
      </ul>

      <h2 className="h3 pt-6 text-ink">Emergencies</h2>
      <p>
        In any emergency, always call your local emergency number first. Sahaya can
        help coordinate and notify trusted contacts, but it cannot guarantee that a
        message is delivered, received, or acted on, and it does not replace
        emergency responders.
      </p>

      <h2 className="h3 pt-6 text-ink">How each agent is limited</h2>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <span className="font-semibold text-ink">Guardian</span> does not
          automatically intercept every call or conclusively identify cloned
          voices, and it does not dispatch emergency services itself.
        </li>
        <li>
          <span className="font-semibold text-ink">Care</span> does not prescribe
          medication, change dosages, or confirm that a dose was taken without the
          user&apos;s input. Purchases always require the user&apos;s
          authorization.
        </li>
        <li>
          <span className="font-semibold text-ink">Wellness</span> provides
          conversational observations, not clinical measurements, and is not a
          diagnostic tool.
        </li>
        <li>
          <span className="font-semibold text-ink">Finance</span> never transfers
          money, pays bills, or submits a dispute on its own. Sensitive actions
          always require the user&apos;s explicit authorization.
        </li>
      </ul>

      <h2 className="h3 pt-6 text-ink">Your authorization comes first</h2>
      <p>
        Sahaya is designed to keep the user in control. Sensitive actions, such as
        making a purchase, sharing a wellness summary with family, or preparing a
        financial dispute, are taken only with the user&apos;s explicit approval.
        Users and their trusted contacts are responsible for reviewing what Sahaya
        prepares before acting on it.
      </p>

      <h2 className="h3 pt-6 text-ink">Eligibility and accounts</h2>
      <p>
        Sahaya is intended for adults. Users and the family members or caregivers
        they invite are responsible for keeping account access secure and for the
        permissions they grant to one another.
      </p>

      <h2 className="h3 pt-6 text-ink">Acceptable use</h2>
      <p>
        Please use Sahaya only for its intended purpose of supporting an older
        adult&apos;s safety, health, and independence. Do not use it to deceive,
        surveil without consent, or harm the user or anyone else.
      </p>

      <h2 className="h3 pt-6 text-ink">No warranty and limits of liability</h2>
      <p>
        Sahaya is provided on an as-is basis while in development. We work hard to
        make it accurate and reliable, but we cannot guarantee it will catch every
        scam, detect every change, or be free of errors. To the fullest extent
        permitted by law, Sahaya is not liable for decisions made in reliance on
        its assistance. Always use your own judgment and consult professionals for
        medical, financial, and legal matters.
      </p>

      <h2 className="h3 pt-6 text-ink">Changes and contact</h2>
      <p>
        Full terms of service will be published, and reviewed by qualified
        advisers, before any public release. This draft reflects our intended
        approach in the meantime. For questions, please use the contact page.
      </p>

      <p className="pt-2 text-sm text-faint">
        This is a draft for transparency and does not yet constitute a legally
        binding agreement.
      </p>
    </DraftPage>
  );
}
