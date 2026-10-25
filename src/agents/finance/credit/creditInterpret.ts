/**
 * Finance's interpretation of CRS responses. Pure and deterministic: every
 * finding is computed in code from named response fields and carries the exact
 * evidence (source, field path, value) it was derived from. Claude only explains
 * these findings afterwards; it never decides what the findings are.
 *
 * Field names follow the CRS Standard Format (credit report), TransUnion
 * TruValidate (identity verification) and AtData FraudFinder responses.
 */

export type Severity = "high" | "medium" | "low" | "info";

export interface Evidence {
  source:
    | "TransUnion credit report"
    | "TransUnion identity verification"
    | "AtData FraudFinder"
    | "Previous review"
    /** A finding Finance derived from other findings (not a CRS field). */
    | "Finance (derived)";
  field: string;
  value: string;
}

export interface CreditFinding {
  id: string;
  category: "credit" | "identity" | "fraud" | "change";
  severity: Severity;
  title: string;
  detail: string;
  evidence: Evidence[];
}

/** What is remembered between reviews, for change detection. No SSN. */
export interface CreditSnapshot {
  asOf: string;
  score?: number;
  scoreModel?: string;
  inquiryKeys: string[];
  tradelineKeys: string[];
  pastDueTotal: number;
  idvRisk?: string;
  fraudScore?: number;
}

export interface CreditInterpretation {
  asOf: string;
  overall: "attention" | "watch" | "clear";
  findings: CreditFinding[];
  snapshot: CreditSnapshot;
  /** Plain facts for display (score, counts); every value also appears in evidence. */
  facts: Record<string, string | number | undefined>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]).map(obj) : []);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const DAY = 86_400_000;
const day = (d: string): number => Date.parse(d.slice(0, 10));

/** Largest number of inquiries inside any rolling window of `windowDays`. */
function maxInWindow(dates: string[], windowDays: number): { count: number; from?: string; to?: string } {
  const sorted = dates.filter((d) => !Number.isNaN(day(d))).sort();
  let best = { count: 0, from: undefined as string | undefined, to: undefined as string | undefined };
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (day(sorted[hi]) - day(sorted[lo]) > windowDays * DAY) lo++;
    const count = hi - lo + 1;
    if (count > best.count) best = { count, from: sorted[lo], to: sorted[hi] };
  }
  return best;
}

export const INQUIRY_WINDOW_DAYS = 30;
export const INQUIRY_LOOKBACK_DAYS = 120;
/** FraudFinder risk.score at or above this is treated as elevated. The scale is not
 * documented in the CRS spec; CRS's own recommended "risky" demo persona (P13)
 * scores 88, so higher is treated as riskier. Severity also depends on sub-signals. */
export const FRAUD_SCORE_ELEVATED = 70;

export function interpretCreditData(input: {
  creditReport?: Obj;
  identityVerification?: Obj;
  fraudFinder?: Obj;
  previous?: CreditSnapshot;
  now?: Date;
}): CreditInterpretation {
  const findings: CreditFinding[] = [];
  const report = input.creditReport ? obj(input.creditReport) : undefined;
  const idv = input.identityVerification ? obj(input.identityVerification) : undefined;
  const ff = input.fraudFinder ? obj(input.fraudFinder) : undefined;
  const asOf = (str(obj(report?.responseDetail).dateRequested) || (input.now ?? new Date()).toISOString()).slice(0, 10);
  const facts: CreditInterpretation["facts"] = { asOf };

  const snapshot: CreditSnapshot = { asOf, inquiryKeys: [], tradelineKeys: [], pastDueTotal: 0 };

  // ---------------- Credit report (CRS Standard Format) ----------------
  if (report) {
    const R = "TransUnion credit report" as const;
    const score = arr(report.scores)[0];
    if (score) {
      const value = num(score.scoreValue);
      snapshot.score = value;
      snapshot.scoreModel = str(score.modelName);
      facts.score = value;
      facts.scoreModel = str(score.modelName);
      const factors = arr(score.scoreFactors).map((f) => str(f.scoreFactorText)).filter(Boolean);
      findings.push({
        id: "credit-score",
        category: "credit",
        severity: "info",
        title: `Credit score ${value} (${str(score.modelName)})`,
        detail: `Score ${value} on a ${str(score.scoreMinimumValue)} to ${str(score.scoreMaximumValue)} scale${
          score.scoreRankPercentileValue ? `, percentile ${str(score.scoreRankPercentileValue)}` : ""
        }.${factors.length ? ` Main factors: ${factors.join("; ")}.` : ""}`,
        evidence: [
          { source: R, field: "scores[0].scoreValue", value: str(score.scoreValue) },
          { source: R, field: "scores[0].modelName", value: str(score.modelName) },
          ...factors.map((t, i) => ({ source: R, field: `scores[0].scoreFactors[${i}].scoreFactorText`, value: t })),
        ],
      });
    }

    // Inquiries: a burst of hard inquiries can mean someone is applying for credit.
    const inquiries = arr(report.inquiries);
    snapshot.inquiryKeys = inquiries.map((q) => `${str(q.inquiryDate)}|${str(q.creditorName)}|${str(q.subscriberCode)}`);
    facts.inquiryCount = inquiries.length;
    const recent = inquiries.filter((q) => day(asOf) - day(str(q.inquiryDate)) <= INQUIRY_LOOKBACK_DAYS * DAY);
    const burst = maxInWindow(recent.map((q) => str(q.inquiryDate)), INQUIRY_WINDOW_DAYS);
    if (burst.count >= 3) {
      const creditors = [...new Set(recent.map((q) => str(q.creditorName)))];
      facts.inquiryBurst = burst.count;
      findings.push({
        id: "inquiry-burst",
        category: "credit",
        severity: burst.count >= 6 ? "high" : "medium",
        title: `${burst.count} credit inquiries within ${INQUIRY_WINDOW_DAYS} days`,
        detail: `${burst.count} hard inquiries between ${burst.from} and ${burst.to} from ${creditors.join(", ")}. A cluster like this happens when several credit applications are made in this name.`,
        evidence: [
          { source: R, field: "inquiries.length", value: String(inquiries.length) },
          { source: R, field: "inquiries[].inquiryDate (first in window)", value: str(burst.from) },
          { source: R, field: "inquiries[].inquiryDate (last in window)", value: str(burst.to) },
          { source: R, field: "inquiries[].creditorName", value: creditors.join(", ") },
        ],
      });
    }

    // Tradelines: past-due or derogatory accounts.
    const tradelines = arr(report.tradelines);
    snapshot.tradelineKeys = tradelines.map((t) => `${str(t.creditorName)}|${str(t.accountIdentifier)}|${str(t.accountOpenedDate)}`);
    facts.tradelineCount = tradelines.length;
    const bad = tradelines.filter((t) => num(t.pastDueAmount) > 0 || t.derogatoryDataIndicator === true);
    const pastDueTotal = tradelines.reduce((s, t) => s + num(t.pastDueAmount), 0);
    snapshot.pastDueTotal = pastDueTotal;
    if (bad.length) {
      findings.push({
        id: "past-due",
        category: "credit",
        severity: "high",
        title: `${bad.length} account(s) past due or derogatory`,
        detail: `Past-due total $${pastDueTotal}. Accounts: ${bad.map((t) => `${str(t.creditorName)} (${str(t.currentRatingType) || "status unknown"})`).join(", ")}.`,
        evidence: bad.flatMap((t, i) => [
          { source: R, field: `tradelines[${i}].creditorName`, value: str(t.creditorName) },
          { source: R, field: `tradelines[${i}].pastDueAmount`, value: str(t.pastDueAmount) },
        ]),
      });
    }

    // Utilization from the CRS trade summary.
    const ts = obj(obj(report.summaries).tradeSummary);
    const revBal = num(ts.revolvingBalanceTotal);
    const revLimit = num(ts.revolvingHighCreditTotal);
    if (revLimit > 0) {
      const pct = Math.round((revBal / revLimit) * 100);
      facts.utilizationPct = pct;
      if (pct >= 30) {
        findings.push({
          id: "high-utilization",
          category: "credit",
          severity: pct >= 70 ? "high" : "medium",
          title: `Card balances use ${pct}% of available credit`,
          detail: `Revolving balances $${revBal} against $${revLimit} of credit. Above about 30% usually lowers scores.`,
          evidence: [
            { source: R, field: "summaries.tradeSummary.revolvingBalanceTotal", value: str(ts.revolvingBalanceTotal) },
            { source: R, field: "summaries.tradeSummary.revolvingHighCreditTotal", value: str(ts.revolvingHighCreditTotal) },
          ],
        });
      }
    }

    // Authorized-user accounts are someone else's card the person was added to.
    const au = tradelines.filter((t) => str(t.accountOwnershipType) === "AuthorizedUser");
    if (au.length) {
      findings.push({
        id: "authorized-user-accounts",
        category: "identity",
        severity: au.length >= 2 && au.length >= tradelines.length / 2 ? "medium" : "low",
        title: `${au.length} of ${tradelines.length} accounts are authorized-user accounts`,
        detail: `These are other people's cards this file was added to (${au.map((t) => str(t.creditorName)).join(", ")}). Worth confirming the person knows who added them.`,
        evidence: au.map((t, i) => ({ source: R, field: `tradelines[${i}].accountOwnershipType`, value: `${str(t.creditorName)}: AuthorizedUser` })),
      });
    }

    // CRS can return HTTP 200 with errorMessages (e.g. E1005 for an unknown config).
    const errors = (Array.isArray(report.errorMessages) ? report.errorMessages : []).map((e) =>
      (typeof e === "string" ? e : JSON.stringify(e)).slice(0, 200),
    );
    if (errors.length) {
      findings.push({
        id: "crs-report-error",
        category: "credit",
        severity: "info",
        title: "CRS returned error messages with the report",
        detail: errors.join("; "),
        evidence: errors.map((e, i) => ({ source: R, field: `errorMessages[${i}]`, value: e })),
      });
    }
  }

  // ---------------- Identity verification (TransUnion TruValidate) ----------------
  if (idv) {
    const S = "TransUnion identity verification" as const;
    const status = obj(obj(idv.fileSummary).creditDataStatus);
    if (obj(status.freeze).indicator === true) {
      findings.push({ id: "freeze-on", category: "identity", severity: "info", title: "A security freeze is on this file", detail: "New creditors cannot see this credit file while the freeze is on.", evidence: [{ source: S, field: "fileSummary.creditDataStatus.freeze.indicator", value: "true" }] });
    }
    if (status.disputed === true) {
      findings.push({ id: "file-disputed", category: "identity", severity: "info", title: "Part of this file is already under dispute", detail: "TransUnion reports an open dispute on this file.", evidence: [{ source: S, field: "fileSummary.creditDataStatus.disputed", value: "true" }] });
    }

    const custom = obj(obj(idv.custom).idmanagerVerAnalysisV2);
    const summary = obj(custom.verificationSummary);
    const risk = str(summary.riskIndicator);
    if (risk) {
      snapshot.idvRisk = risk;
      facts.identityRisk = risk;
    }
    const keyMessages = arr(obj(summary.keyMessages).keyMessages).map((k) => str(k.text)).filter(Boolean);
    const mismatches = arr(idv.addOnProducts)
      .flatMap((p) => arr(obj(p.idManagerVerification).messages))
      .map((m) => ({ code: str(m.code), text: str(m.text) }))
      .filter((m) => m.text);
    if (risk === "HIGH" || risk === "MEDIUM" || mismatches.length) {
      findings.push({
        id: "identity-mismatch",
        category: "identity",
        severity: risk === "HIGH" ? "high" : "medium",
        title: `Identity check: ${risk || "issues found"} risk${mismatches.length ? `, ${mismatches.length} mismatch(es)` : ""}`,
        detail: [
          risk ? `TransUnion rated the identity match ${risk} (verification point ${str(summary.verificationPoint)}).` : "",
          mismatches.length ? `It reported: ${mismatches.map((m) => m.text.toLowerCase()).join("; ")}.` : "",
          keyMessages.length ? `Alerts: ${keyMessages.join("; ")}.` : "",
        ].filter(Boolean).join(" "),
        evidence: [
          ...(risk ? [{ source: S, field: "custom.idmanagerVerAnalysisV2.verificationSummary.riskIndicator", value: risk }] : []),
          ...(summary.verificationPoint !== undefined ? [{ source: S, field: "custom.idmanagerVerAnalysisV2.verificationSummary.verificationPoint", value: str(summary.verificationPoint) }] : []),
          ...mismatches.map((m) => ({ source: S, field: `addOnProducts[].idManagerVerification.messages[${m.code}]`, value: m.text })),
          ...keyMessages.map((t) => ({ source: S, field: "verificationSummary.keyMessages[].text", value: t })),
        ],
      });
    }
  }

  // ---------------- FraudFinder (AtData) ----------------
  if (ff) {
    const S = "AtData FraudFinder" as const;
    const risk = obj(ff.risk);
    const score = risk.score === undefined ? undefined : num(risk.score);
    if (score !== undefined) {
      snapshot.fraudScore = score;
      facts.fraudScore = score;
    }
    const phone = obj(risk.phone);
    const owner = obj(phone.owner);
    const phoneSignals: string[] = [];
    if (str(phone.line_type) === "voip") phoneSignals.push("internet (VOIP) line");
    if (phone.prepaid === true) phoneSignals.push("prepaid");
    if (str(owner.last_name_match) === "no_match" || str(owner.first_name_match) === "no_match") phoneSignals.push("registered to someone else");
    const eam = obj(ff.eam);
    const emailFirstSeen = str(eam.date_first_seen);
    const emailNew = emailFirstSeen && day(asOf) - day(emailFirstSeen) <= 30 * DAY;
    const ipDistance = str(obj(risk.postal).ip_postal_distance);
    const ipFar = /> ?1000/.test(ipDistance);

    const signals = phoneSignals.length + (emailNew ? 1 : 0) + (ipFar ? 1 : 0);
    if ((score !== undefined && score >= FRAUD_SCORE_ELEVATED) || signals >= 2) {
      findings.push({
        id: "contact-fraud-signals",
        category: "fraud",
        severity: score !== undefined && score >= FRAUD_SCORE_ELEVATED && signals >= 2 ? "high" : "medium",
        title: `Contact details look risky${score !== undefined ? ` (FraudFinder score ${score})` : ""}`,
        detail: [
          phoneSignals.length ? `The phone on file is ${phoneSignals.join(", ")}.` : "",
          emailNew ? `The email address was first seen on ${emailFirstSeen}.` : "",
          ipFar ? `The internet location is ${ipDistance} from the home address.` : "",
        ].filter(Boolean).join(" "),
        evidence: [
          ...(score !== undefined ? [{ source: S, field: "risk.score", value: String(score) }] : []),
          ...(phone.line_type ? [{ source: S, field: "risk.phone.line_type", value: str(phone.line_type) }] : []),
          ...(phone.prepaid !== undefined ? [{ source: S, field: "risk.phone.prepaid", value: str(phone.prepaid) }] : []),
          ...(owner.last_name_match ? [{ source: S, field: "risk.phone.owner.last_name_match", value: str(owner.last_name_match) }] : []),
          ...(emailFirstSeen ? [{ source: S, field: "eam.date_first_seen", value: emailFirstSeen }] : []),
          ...(ipDistance ? [{ source: S, field: "risk.postal.ip_postal_distance", value: ipDistance }] : []),
        ],
      });
    }
  }

  // ---------------- Combined pattern ----------------
  const has = (id: string) => findings.some((f) => f.id === id);
  const supporting = ["identity-mismatch", "contact-fraud-signals", "authorized-user-accounts"].filter(has);
  if (has("inquiry-burst") && supporting.length >= 2) {
    findings.push({
      id: "possible-identity-misuse",
      category: "fraud",
      severity: "high",
      title: "Signals together match a pattern of someone applying for credit in this name",
      detail: `A burst of inquiries plus ${supporting.join(" and ")} is a pattern seen when another person uses someone's details to apply for credit. It is not proof; the person should confirm whether they made these applications.`,
      evidence: [
        { source: "Finance (derived)", field: "finding", value: "inquiry-burst" },
        ...supporting.map((s) => ({ source: "Finance (derived)" as const, field: "finding", value: s })),
      ],
    });
  }

  // ---------------- Change since last review ----------------
  if (input.previous) {
    const P = input.previous;
    const changes: string[] = [];
    const ev: Evidence[] = [{ source: "Previous review", field: "asOf", value: P.asOf }];
    if (snapshot.score !== undefined && P.score !== undefined && snapshot.score !== P.score) {
      changes.push(`score moved from ${P.score} to ${snapshot.score}`);
      ev.push({ source: "Previous review", field: "score", value: String(P.score) });
    }
    const newInquiries = snapshot.inquiryKeys.filter((k) => !P.inquiryKeys.includes(k));
    if (report && newInquiries.length) {
      changes.push(`${newInquiries.length} new inquiry(ies)`);
      ev.push({ source: "TransUnion credit report", field: "inquiries (new since last review)", value: String(newInquiries.length) });
    }
    const newAccounts = snapshot.tradelineKeys.filter((k) => !P.tradelineKeys.includes(k));
    if (report && newAccounts.length) {
      changes.push(`${newAccounts.length} new account(s)`);
      ev.push({ source: "TransUnion credit report", field: "tradelines (new since last review)", value: String(newAccounts.length) });
    }
    if (snapshot.idvRisk && P.idvRisk && snapshot.idvRisk !== P.idvRisk) changes.push(`identity risk changed from ${P.idvRisk} to ${snapshot.idvRisk}`);
    if (snapshot.fraudScore !== undefined && P.fraudScore !== undefined && snapshot.fraudScore !== P.fraudScore) {
      changes.push(`FraudFinder score moved from ${P.fraudScore} to ${snapshot.fraudScore}`);
    }
    const scoreDrop = P.score !== undefined && snapshot.score !== undefined ? P.score - snapshot.score : 0;
    findings.push(
      changes.length
        ? {
            id: "change-since-last-review",
            category: "change",
            severity: newInquiries.length >= 3 || newAccounts.length > 0 || scoreDrop >= 20 ? "medium" : "low",
            title: `Changed since the review on ${P.asOf}`,
            detail: `Since ${P.asOf}: ${changes.join("; ")}.`,
            evidence: ev,
          }
        : {
            id: "no-change",
            category: "change",
            severity: "info",
            title: `No change since the review on ${P.asOf}`,
            detail: "Score, inquiries, accounts and risk ratings match the previous review.",
            evidence: ev,
          },
    );
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const overall = findings.some((f) => f.severity === "high")
    ? "attention"
    : findings.some((f) => f.severity === "medium")
      ? "watch"
      : "clear";
  return { asOf, overall, findings, snapshot, facts };
}
