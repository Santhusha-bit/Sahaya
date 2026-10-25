/**
 * Two realistic demo documents for Margaret's August 14 visit. Copies live in
 * public/samples/ so they can be downloaded and uploaded through the UI.
 *
 * The planted problem: the hospital billed CPT 80053 twice. The insurer denied
 * the second line as a duplicate (remark D17, member not responsible), but the
 * hospital never wrote it off, so the statement asks for $212.00 while the EOB
 * says Margaret owes $64.00. The $148.00 gap is exactly the duplicate charge.
 */

export const SAMPLE_BILL_FILENAME = "bayview-statement-2026-09.txt";
export const SAMPLE_EOB_FILENAME = "golden-state-eob-2026-09.txt";

export const SAMPLE_BILL_TEXT = `BAYVIEW COMMUNITY HOSPITAL
Patient Financial Services
1200 Harbor Way, San Francisco, CA 94107
Billing questions: billing@bayview-community.example | (555) 010-4400

PATIENT STATEMENT
Statement date: 09/30/2026
Patient: Margaret Chen
Account number: 0000-3318-4471
Insurance: Golden State Health Plan
Claim number: GSH-26-0814-55210

DATE        CODE   DESCRIPTION                                    CHARGE
08/14/2026  99214  Office/outpatient visit, established patient  $285.00
08/14/2026  80053  Comprehensive metabolic panel                  $148.00
08/14/2026  80053  Comprehensive metabolic panel                  $148.00
08/14/2026  85025  Complete blood count with differential          $62.00
08/14/2026  36415  Routine venipuncture                            $28.00
08/14/2026  93000  Electrocardiogram, complete                    $175.00

Total charges:                                                    $846.00
Insurance payments (Golden State Health Plan, 09/12/2026):       -$256.00
Insurance adjustments:                                           -$378.00
AMOUNT YOU OWE:                                                   $212.00

Payment due by 10/30/2026. Thank you for choosing Bayview.
`;

export const SAMPLE_EOB_TEXT = `GOLDEN STATE HEALTH PLAN
EXPLANATION OF BENEFITS - THIS IS NOT A BILL
Member services: (555) 010-7788

Member: Margaret Chen
Member ID: GSH-XXXXX-2093
Claim number: GSH-26-0814-55210
Provider: Bayview Community Hospital
Date processed: 09/12/2026

DATE        CODE   DESCRIPTION                         BILLED   ALLOWED  PLAN PAID  YOU OWE  REMARK
08/14/2026  99214  Office visit, established patient  $285.00  $182.00    $145.60   $36.40
08/14/2026  80053  Comprehensive metabolic panel      $148.00   $42.00     $33.60    $8.40
08/14/2026  80053  Comprehensive metabolic panel      $148.00    $0.00      $0.00    $0.00  D17
08/14/2026  85025  Complete blood count w/ diff        $62.00   $21.00     $16.80    $4.20
08/14/2026  36415  Routine venipuncture                $28.00   $10.00      $8.00    $2.00
08/14/2026  93000  Electrocardiogram, complete        $175.00   $65.00     $52.00   $13.00

TOTALS                                                $846.00  $320.00    $256.00   $64.00

REMARK CODES
D17  Duplicate of a service already processed on this claim. The member is not responsible for this charge.

Your total responsibility for this claim: $64.00
`;

export function sampleDocuments(): { fileName: string; text: string }[] {
  return [
    { fileName: SAMPLE_BILL_FILENAME, text: SAMPLE_BILL_TEXT },
    { fileName: SAMPLE_EOB_FILENAME, text: SAMPLE_EOB_TEXT },
  ];
}
