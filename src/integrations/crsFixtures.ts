/**
 * Offline CRS fixtures for sandbox mode (no credentials).
 *
 * Each body mirrors a recorded CRS Cal Hacks sandbox response for test persona
 * P13 (a fictional CRS test identity; SSN in the never-issued 666 range). They let
 * the Finance credit review run deterministically in tests and demos. Anything
 * served from here is labeled mode "sandbox", never "live".
 */

type Fixture = Partial<Record<"credit_report" | "identity_verification" | "fraud_finder", Record<string, unknown>>>;

export const CRS_FIXTURES: Record<string, Fixture> = {
  "P13": {
    "credit_report": {
      "requestData": {
        "firstName": "KAYLA",
        "lastName": "BRENNAN",
        "ssn": "666701013",
        "addresses": [
          {
            "borrowerResidencyType": "Current",
            "addressLine1": "9021 KINGSTON PIKE",
            "city": "KNOXVILLE",
            "state": "TN",
            "postalCode": "37923"
          }
        ]
      },
      "repositoryIncluded": {
        "transunion": true,
        "experian": false,
        "equifax": false
      },
      "responseDetail": {
        "dateRequested": "2026-10-24T21:44:38.433109Z",
        "requestingParty": {
          "name": "CALHACKS13"
        },
        "creditBureauContact": {
          "name": "CREDIT REPORTING SERVICES, INC",
          "address": {
            "addressLine1": "1024 IRON POINT ROAD",
            "city": "FOLSOM",
            "state": "CA",
            "postalCode": "95630"
          }
        }
      },
      "responseAlertMessages": [],
      "creditFiles": [
        {
          "creditFileDetail": {
            "borrowerSourceType": "Borrower",
            "creditFileInfileDate": "2024-10-01",
            "creditFileResultStatusType": "FileReturned",
            "sourceType": "TransUnion"
          },
          "aliases": [
            {
              "firstName": "KAYLA",
              "lastName": "BRENNAN",
              "middleName": "D"
            }
          ],
          "employments": [
            {
              "employerName": "JOE",
              "employmentReportedDate": "2024-10-10"
            },
            {
              "employerName": "AGF",
              "employmentReportedDate": "2024-10-10"
            }
          ]
        }
      ],
      "inquiries": [
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-08-19",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-08-22",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-08-25",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-08-28",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-08-31",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-09-03",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-09-06",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-09-09",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        },
        {
          "creditorName": "RICHTEST",
          "accountOwnershipType": "Individual",
          "borrowerSourceType": "Borrower",
          "inquiryDate": "2026-09-12",
          "businessType": "RealEstateAndPublicAccommodation",
          "subscriberCode": "R 00001962",
          "sourceType": "TransUnion"
        }
      ],
      "tradelines": [
        {
          "accountIdentifier": "CALHACKS-CARD-1",
          "accountOpenedDate": "2025-08-01",
          "accountOwnershipType": "Individual",
          "accountReportedDate": "2026-09-01",
          "accountStatusType": "Open",
          "accountType": "Revolving",
          "borrowerSourceType": "Borrower",
          "creditLimitAmount": "2500",
          "derogatoryDataIndicator": false,
          "highBalanceAmount": "800",
          "lastActivityDate": "2026-08-20",
          "monthlyPaymentAmount": "75",
          "monthsReviewedCount": "14",
          "creditorName": "NEW HORIZON BANK",
          "subscriberCode": "B 01597029",
          "pastDueAmount": "0",
          "termsDescription": "48 months at $75 per month",
          "termsMonthsCount": "48",
          "currentBalanceAmount": "300",
          "businessType": "Banking",
          "loanType": "CreditCard",
          "currentRatingCode": "C",
          "currentRatingType": "AsAgreed",
          "paymentPatternData": "CCCCCCCCCCCCC",
          "paymentPatternStartDate": "2026-09-01",
          "sourceType": "TransUnion"
        },
        {
          "accountIdentifier": "CALHACKS-AU-1",
          "accountOpenedDate": "2025-08-15",
          "accountOwnershipType": "AuthorizedUser",
          "accountReportedDate": "2026-09-01",
          "accountStatusType": "Open",
          "accountType": "Revolving",
          "borrowerSourceType": "Borrower",
          "creditLimitAmount": "3500",
          "derogatoryDataIndicator": false,
          "highBalanceAmount": "1200",
          "lastActivityDate": "2026-08-20",
          "monthlyPaymentAmount": "75",
          "monthsReviewedCount": "14",
          "creditorName": "PREMIER CARD SERVICES",
          "subscriberCode": "B 01597029",
          "pastDueAmount": "0",
          "termsDescription": "48 months at $75 per month",
          "termsMonthsCount": "48",
          "currentBalanceAmount": "600",
          "businessType": "Banking",
          "loanType": "CreditCard",
          "currentRatingCode": "C",
          "currentRatingType": "AsAgreed",
          "paymentPatternData": "CCCCCCCCCCCCC",
          "paymentPatternStartDate": "2026-09-01",
          "sourceType": "TransUnion"
        },
        {
          "accountIdentifier": "CALHACKS-AU-2",
          "accountOpenedDate": "2025-09-01",
          "accountOwnershipType": "AuthorizedUser",
          "accountReportedDate": "2026-09-01",
          "accountStatusType": "Open",
          "accountType": "Revolving",
          "borrowerSourceType": "Borrower",
          "creditLimitAmount": "1500",
          "derogatoryDataIndicator": false,
          "highBalanceAmount": "350",
          "lastActivityDate": "2026-08-20",
          "monthlyPaymentAmount": "75",
          "monthsReviewedCount": "13",
          "creditorName": "DEPT STORE CHARGE",
          "subscriberCode": "B 01597029",
          "pastDueAmount": "0",
          "termsDescription": "48 months at $75 per month",
          "termsMonthsCount": "48",
          "currentBalanceAmount": "0",
          "businessType": "Banking",
          "loanType": "ChargeAccount",
          "currentRatingCode": "C",
          "currentRatingType": "AsAgreed",
          "paymentPatternData": "CCCCCCCCCCCCC",
          "paymentPatternStartDate": "2026-09-01",
          "sourceType": "TransUnion"
        }
      ],
      "publicRecords": [],
      "scores": [
        {
          "borrowerSourceType": "Borrower",
          "modelName": "TransUnionVantageScore4.0",
          "modelNameType": "001NN",
          "sourceType": "TransUnion",
          "factaInquiriesIndicator": false,
          "scoreValue": "640",
          "scoreRankPercentileValue": "23",
          "scoreMaximumValue": "850",
          "scoreMinimumValue": "300",
          "scoreFactors": [
            {
              "scoreFactorCode": "27",
              "scoreFactorText": "Delinquent or derogatory status on revolving accounts is too recent"
            },
            {
              "scoreFactorCode": "16",
              "scoreFactorText": "Total of credit limits and loan amounts is too low"
            },
            {
              "scoreFactorCode": "15",
              "scoreFactorText": "Lack of recently reported accounts"
            },
            {
              "scoreFactorCode": "8",
              "scoreFactorText": ""
            }
          ]
        }
      ],
      "summaries": {
        "tradeSummary": {
          "mortgageTradesCount": "0",
          "mortgageBalanceTotal": "0",
          "mortgageHighCreditTotal": "0",
          "mortgagePaymentsTotal": "0",
          "mortgagePastDueTotal": "0",
          "autoTradesCount": "0",
          "autoBalanceTotal": "0",
          "autoHighCreditTotal": "0",
          "autoPaymentsTotal": "0",
          "autoPastDueTotal": "0",
          "educationTradesCount": "0",
          "educationBalanceTotal": "0",
          "educationHighCreditTotal": "0",
          "educationPaymentsTotal": "0",
          "educationPastDueTotal": "0",
          "openTradesCount": "0",
          "openBalanceTotal": "0",
          "openHighCreditTotal": "0",
          "openPaymentsTotal": "0",
          "openPastDueTotal": "0",
          "revolvingTradesCount": "3",
          "revolvingBalanceTotal": "900",
          "revolvingHighCreditTotal": "7500",
          "revolvingPaymentsTotal": "225",
          "revolvingPastDueTotal": "0",
          "unknownTradesCount": "0",
          "unknownBalanceTotal": "0",
          "unknownHighCreditTotal": "0",
          "unknownPaymentsTotal": "0",
          "unknownPastDueTotal": "0",
          "installmentOtherTradesCount": "0",
          "installmentOtherBalanceTotal": "0",
          "installmentOtherHighCreditTotal": "0",
          "installmentOtherPaymentsTotal": "0",
          "installmentOtherPastDueTotal": "0",
          "applicableMortgagePaymentsTotal": "0",
          "applicableAutoPaymentsTotal": "0",
          "applicableEducationPaymentsTotal": "0",
          "applicableOpenPaymentsTotal": "0",
          "applicableRevolvingPaymentsTotal": "150",
          "applicableUnknownPaymentsTotal": "0",
          "applicableInstallmentPaymentsTotal": "0",
          "applicableInstallmentOtherPaymentsTotal": "0",
          "applicableMortgageHighCreditTotal": "0",
          "applicableAutoHighCreditTotal": "0",
          "applicableEducationHighCreditTotal": "0",
          "applicableOpenHighCreditTotal": "0",
          "applicableRevolvingHighCreditTotal": "7500",
          "applicableUnknownHighCreditTotal": "0",
          "applicableInstallmentHighCreditTotal": "0",
          "applicableInstallmentOtherHighCreditTotal": "0",
          "tradesCount": "3",
          "balanceTotal": "900",
          "applicablePaymentsTotal": "150",
          "applicableHighCreditTotal": "7500",
          "highCreditTotal": "7500",
          "paymentsTotal": "225",
          "pastDueTotal": "0",
          "securedDebtBalanceTotal": "0",
          "unsecuredDebtBalanceTotal": "900",
          "oldestTradelineDate": "2025-08-01",
          "oldestTradelineCreditorName": "NEW HORIZON BANK",
          "revolvingCreditUtilization": "12",
          "totalDebtHighCreditRatio": "12"
        },
        "derogatorySummary": {
          "chargeOffsCount": "0",
          "collectionsCount": "0",
          "bankruptciesCount": "0",
          "publicRecordsCount": "0",
          "satisfactoryTradelineCount": "3",
          "_30DayLates": "0",
          "_60DayLates": "0",
          "_90DayLates": "0",
          "inquiriesCount": "9",
          "mostRecentLateDate": "",
          "disputesCount": "0",
          "currentAdverseTradelineCount": "0",
          "priorAdverseTradelineCount": "0",
          "otherCount": "0",
          "securedDebtBalanceTotal": "0",
          "unsecuredDebtBalanceTotal": "900"
        }
      }
    },
    "identity_verification": {
      "fileNumber": "01",
      "fileSummary": {
        "fileHitIndicator": "SUBJECT_HIT",
        "creditDataStatus": {
          "suppressed": false,
          "doNotPromote": {
            "indicator": false
          },
          "freeze": {
            "indicator": false
          },
          "minor": false,
          "disputed": false
        }
      },
      "indicative": {
        "names": [
          {
            "person": {
              "first": "KAYLA",
              "middle": "D",
              "last": "BRENNAN"
            },
            "source": "INPUT"
          }
        ],
        "addresses": [
          {
            "status": "CURRENT",
            "street": {
              "unparseds": [],
              "number": "9021",
              "name": "KINGSTON PIKE"
            },
            "location": {
              "city": "KNOXVILLE",
              "state": "TN",
              "zipCode": "37923"
            },
            "source": "INPUT"
          }
        ],
        "socialSecurities": [
          {
            "number": "666701013",
            "identificationIssuance": {
              "type": "SSN",
              "status": "ISSUED_AFTER_21",
              "yearRange": {
                "startYear": "2001",
                "endYear": "2001"
              },
              "state": "KY",
              "ageObtained": {
                "rangeStart": "+35",
                "rangeEnd": "+36"
              }
            },
            "source": "INPUT",
            "masked": false
          },
          {
            "number": "666701013",
            "source": "FILE",
            "masked": false
          }
        ],
        "dateOfBirths": [
          {
            "value": "1999-12-24T00:00:00.000+00:00",
            "source": "INPUT"
          }
        ],
        "ages": [],
        "phones": [
          {
            "number": {
              "qualifier": "PERSONAL"
            },
            "source": "INPUT"
          }
        ],
        "employments": [],
        "creditCards": [],
        "genders": [],
        "vehicles": []
      },
      "originalInputs": [],
      "custom": {
        "idmanagerVerAnalysisV2": {
          "verificationSummary": {
            "riskIndicator": "MEDIUM",
            "bestMatch": "FILE",
            "verificationPoint": 30,
            "lowerThreshold": 5,
            "upperThreshold": 49,
            "keyMessages": {
              "keyMessages": [
                {
                  "code": "KMSG07",
                  "text": "ADDRESS RELATED ALERT"
                }
              ]
            }
          },
          "fraudAnalysis": {
            "region": {
              "zipVsCity": "INVALID",
              "zipVsState": "VALID",
              "phoneVsState": "NOT_AVAILABLE",
              "phoneVsZIP": "NOT_AVAILABLE",
              "phoneVsZIPDistance": "0000.000",
              "source": "INPUT"
            },
            "employment": {},
            "distance": {
              "minimum": {
                "noAnalysisReason": "NOT_AVAILABLE"
              },
              "maximum": {
                "noAnalysisReason": "NOT_AVAILABLE"
              },
              "source": "INPUT"
            }
          },
          "verificationAnalysises": [
            {
              "verificationStatus": "SUBJECT_FOUND",
              "firstNameVerification": "MATCH",
              "middleNameVerification": "INPUT_NOT_AVAILABLE",
              "lastNameVerification": "MATCH",
              "nameSuffixVerification": "MATCH_NOT_PERFORMED",
              "currentAddressVerification": "NO_MATCH",
              "previousAddressVerification": "INPUT_NOT_AVAILABLE",
              "phoneNumberVerification": "INPUT_NOT_AVAILABLE",
              "ssnVerification": "MATCH",
              "dateOfBirthVerification": "NOT_FOUND",
              "source": "FILE"
            },
            {
              "verificationStatus": "SUBJECT_NOT_FOUND",
              "firstNameVerification": "NOT_FOUND",
              "middleNameVerification": "MATCH_NOT_PERFORMED",
              "lastNameVerification": "NOT_FOUND",
              "nameSuffixVerification": "MATCH_NOT_PERFORMED",
              "currentAddressVerification": "NOT_FOUND",
              "previousAddressVerification": "MATCH_NOT_PERFORMED",
              "phoneNumberVerification": "INPUT_NOT_AVAILABLE",
              "ssnVerification": "NOT_FOUND",
              "dateOfBirthVerification": "NOT_FOUND",
              "source": "VENDOR_FILE"
            }
          ]
        }
      },
      "addOnProducts": [
        {
          "code": "FRDMS",
          "status": "DELIVERED",
          "idMismatchAlerts": [],
          "addressAnalysises": [],
          "idManagerVerification": {
            "messages": [
              {
                "code": "2201",
                "text": "INPUT SSN NOT ASSOCIATED WITH INPUT NAME",
                "source": "INPUT"
              },
              {
                "code": "2202",
                "text": "INPUT DATE OF BIRTH DOES NOT MATCH FILE",
                "source": "INPUT"
              },
              {
                "code": "2101",
                "text": "INPUT CURRENT ADDRESS DOES NOT MATCH FILE CURRENT ADDRESS",
                "source": "INPUT"
              }
            ],
            "deceases": [],
            "identificationIssuances": [],
            "returnMessage": "CODES_AND_TEXT",
            "searchStatus": "HIT"
          },
          "creditorContacts": []
        }
      ]
    },
    "fraud_finder": {
      "eam": {
        "date_first_seen": "2026-10-15",
        "longevity": 1,
        "velocity": 9,
        "popularity": 1
      },
      "dam": {
        "date_first_seen": "1995-08-13",
        "longevity": 10,
        "velocity": 1,
        "popularity": 10
      },
      "risk": {
        "score": 88,
        "tumbling_risk": 1,
        "query_id": "calhacks-P13-0001",
        "domain": {
          "domain_risk_score": 0
        },
        "ip": {
          "routing_type": "fixed",
          "organization": "comcast cable communications llc",
          "proxy_type": "",
          "hosting_facility": false,
          "latitude": "34.05",
          "longitude": "-118.24"
        },
        "postal": {
          "first_name_match": "match",
          "last_name_match": "match",
          "street_match": "match",
          "city_match": "match",
          "zip_match": "match",
          "address_type": "Street",
          "deliverability": "deliverable",
          "ip_postal_distance": "> 1000 miles"
        },
        "phone": {
          "line_type": "voip",
          "carrier": "VERIZON WIRELESS",
          "status": "valid",
          "prepaid": true,
          "owner": {
            "first_name_match": "no_match",
            "last_name_match": "no_match",
            "street_match": "no_match",
            "city_match": "no_match",
            "zip_match": "no_match",
            "type": "person"
          }
        }
      },
      "email_validation": {
        "address": "kb.9921x@example.com",
        "status": "valid",
        "status_code": 50,
        "domain_type": "freeisp"
      }
    }
  }
};
