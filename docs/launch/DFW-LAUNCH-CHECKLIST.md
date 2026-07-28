# Texas / DFW launch checklist

**Status:** launch gate, not legal advice  
**Verified against official sources:** July 28, 2026  
**Required owner:** company owner  
**Required reviewers:** Texas attorney, Texas tax professional/CPA, insurance agent, and each applicable municipal environmental authority

> **REQUIRED LEGAL REVIEW:** Every legal, tax, licensing, environmental,
> employment, privacy, contract, and communications determination in this
> checklist must be reviewed for the actual entity, services, chemicals,
> customers, work sites, and municipalities before launch. A checked box records
> evidence of review; it is not a legal conclusion. Revalidate the linked
> sources at launch and at least quarterly because rules and official guidance
> change.

## Hard launch gates

- [ ] **REQUIRED LEGAL REVIEW — entity and trade name.** Record the legal entity,
      registered agent, formation date, counties served, and exact contracting name.
      Determine whether an assumed-name filing is required. Texas distinguishes
      filings for incorporated entities from filings for sole proprietors and other
      unincorporated entities; use the
      [Texas Secretary of State name-filing FAQ](https://www.sos.state.tx.us/corp/namefilingsfaqs.shtml)
      and have counsel confirm the right filing.

- [ ] **REQUIRED LEGAL/TAX REVIEW — EIN and tax accounts.** Obtain an EIN directly
      from the [IRS EIN service](https://www.irs.gov/businesses/employer-identification-number)
      when required, and store the confirmation outside StoryOps. Never enter SSNs,
      EIN application answers, or banking credentials into AI prompts.

- [ ] **REQUIRED TAX REVIEW — Texas sales tax.** Obtain and display a Texas sales
      and use tax permit if the tax reviewer confirms it is required. The Texas
      Comptroller currently states that pressure washing tangible personal property
      is taxable maintenance and pressure washing buildings, sidewalks, and parking
      lots is taxable building/grounds cleaning. See the official
      [Cleaning and Janitorial Services guidance](https://comptroller.texas.gov/taxes/publications/94-111.php)
      and [permit application requirements](https://comptroller.texas.gov/taxes/permit/).
      Have the reviewer separately classify gutter/downspout cleaning, add-ons,
      materials, discounts, travel charges, deposits, and each customer/exemption
      scenario. Do not rely on the demo price book’s tax rate.

- [ ] **REQUIRED LEGAL REVIEW — state and local permits.** Search the current
      [Texas Business Licenses & Permits Guide](https://gov.texas.gov/business/page/business-permits-office)
      and obtain written confirmation for every municipality and county served.
      Texas does not issue one general statewide business license, but the Governor’s
      office warns that activities and localities may require specific permits.

- [ ] **REQUIRED INSURANCE/LEGAL REVIEW.** Bind commercial general liability,
      commercial auto, equipment/inland-marine, pollution/environmental, and any
      umbrella coverage the reviewers require. Confirm exclusions for roof work,
      ladders, overspray, chemical use, wastewater, subcontractors, and care/custody/
      control. Load only policy number, carrier, expiration, and certificate status
      into StoryOps—not full underwriting files.

- [ ] **REQUIRED LEGAL REVIEW — consumer terms.** Counsel must approve quote,
      scope exclusions, access/water/electricity permissions, photo authorization,
      damage reporting, weather/rescheduling, deposits, cancellation, warranty,
      dispute, recurring-service, and e-signature language. If selling away from the
      business location, determine whether Texas cancellation disclosures apply;
      the Texas Attorney General describes certain covered transactions and
      exceptions in its
      [door-to-door sales guidance](https://www.texasattorneygeneral.gov/consumer-protection/home-real-estate-and-travel/door-door-sales-3-day-right-rescission).

- [ ] Complete and sign the
      [exterior-cleaning safety checklist](./EXTERIOR-CLEANING-SAFETY-CHECKLIST.md).
      No service may be activated until its owner-approved SOP, price-book rule,
      checklist, allowed chemicals/products, and stop-work conditions exist.

- [ ] Complete a sandbox golden-path proof and retain the JSON result:
      `npm run demo:proof`. No live provider keys are needed.

- [ ] Complete a backup and restore drill into a disposable local/fresh target.
      Record the backup manifest checksum, restore operator, validation results,
      recovery time, and deletion of the disposable target.

## DFW jurisdiction gates

The service address—not the mailing address, lead source, or company base—drives
the local check. StoryOps must preserve the geocoder result, precision, human
verification, jurisdiction, rule version, and permit decision. Low-precision or
conflicting geocodes require owner review.

### Fort Worth

- [ ] **REQUIRED LEGAL/ENVIRONMENTAL REVIEW — BLOCK DISPATCH until confirmed.**
      The City of Fort Worth states that any person or business engaged in mobile
      commercial cosmetic cleaning must hold a business permit, and that vehicles/
      trailers carrying rigs must be registered. The city’s current page lists
      application documents, unit registration, display, annual term, discharge
      practices, and contacts:
      [Fort Worth Mobile Commercial Cosmetic Cleaning Regulation](https://www.fortworthtexas.gov/departments/environmental-services/environmental-quality/stormwater-quality/powerwash).

- [ ] Store Fort Worth permit number, business expiry, each unit certificate,
      vehicle/trailer association, and evidence link. Add expiry alerts at 60, 30,
      14, and 7 days. An alert is not a renewal.

- [ ] **REQUIRED LEGAL/ENVIRONMENTAL REVIEW — job-specific discharge plan.**
      Record the property owner’s permission and municipal authorization for the
      selected disposal path. The city states that non-exempt wash water must be
      collected before leaving the property, places conditions on sanitary-sewer
      discharge, and forbids opening manholes. Do not generalize an exemption from
      one job to another; washed-off pollutants matter even when no detergent is
      added. Use the city page above and obtain current written direction from the
      Environmental Quality Division.

### Dallas

- [ ] **REQUIRED LEGAL/ENVIRONMENTAL REVIEW — BLOCK DISPATCH until confirmed.**
      Dallas identifies outdoor washing that creates flow to a storm-drain inlet as
      an illicit-discharge example:
      [Dallas Understanding Illicit Discharge](https://dallascityhall.com/departments/trinitywatershedmanagement/wheredoesitgo/Pages/Illicit-Discharge.aspx).

- [ ] Preserve a site-specific containment/disposal plan and current municipal
      direction. Dallas’s official pavement-washing notice says businesses may not
      let water mixed with soap, detergent, or other cleaning chemicals escape to
      streets or storm drains and gives conditional guidance for chemical-free
      wastewater:
      [Dallas Pavement Washing Tips](https://dallascityhall.com/departments/waterutilities/stormwater-operations/PublishingImages/Keep%20Stormwater%20Clean%20Feb%2023_2021.pdf).
      **REQUIRED LEGAL/ENVIRONMENTAL REVIEW:** municipal staff/counsel must decide
      whether and how those conditions apply to the actual surface, pollutants,
      method, and disposal location.

### Every other DFW municipality

- [ ] **REQUIRED LEGAL/ENVIRONMENTAL REVIEW.** Build a municipality matrix before
      adding a service ZIP code. For each city/unincorporated area record:

  - authoritative boundary source and last check;
  - business, contractor, soliciting, home-occupation, and mobile-cleaner permits;
  - stormwater/illicit-discharge rule and enforcement contact;
  - sanitary-sewer/pretreatment authorization path;
  - water-use or drought restrictions;
  - vehicle/trailer display or registration requirements;
  - waste transport/disposal requirements;
  - renewal dates and evidence.

- [ ] Treat “no result found” as **unknown**, not “no permit required.” An owner
      may release the city only after counsel or the relevant authority supplies
      evidence.

## Finance and ownership

- [ ] **REQUIRED TAX/LEGAL REVIEW.** Configure the approved legal name, remit-to
      address, tax permit, tax sourcing, invoice numbering, deposit treatment,
      refund policy, bad-debt process, and record-retention policy.

- [ ] **REQUIRED TAX REVIEW.** Confirm federal income/self-employment/payroll
      obligations, Texas franchise-tax/public-information reporting, and local
      personal-property obligations for the chosen entity. StoryOps reminders do
      not file returns.

- [ ] **REQUIRED LEGAL REVIEW.** Recheck federal beneficial-ownership reporting
      immediately before formation and quarterly. FinCEN currently says
      U.S.-created entities and U.S. persons are exempt under the revised rule, but
      foreign entities may still be reporting companies:
      [FinCEN BOI reporting](https://www.fincen.gov/boi). Do not hard-code an
      exemption into an agent.

- [ ] Use a business bank account and Stripe-hosted payment collection. StoryOps
      must never store full card data, bank credentials, or provider secret keys.
      Match payment state only from a verified provider response/webhook.

- [ ] Test a refund proposal. It must enter approval and must not call a live
      provider until the owner approves the exact amount, payment, reason, and
      idempotency key.

## People, vehicles, and equipment

- [ ] **REQUIRED EMPLOYMENT/INSURANCE LEGAL REVIEW.** Before hiring or using a
      helper/subcontractor, determine classification, onboarding, payroll, I-9,
      training, supervision, insurance, incident reporting, and workers’
      compensation/non-subscriber obligations. Texas says most private employers
      may choose whether to subscribe, with reporting and other consequences for
      non-subscribers:
      [Texas Department of Insurance employer resources](https://tdi.texas.gov/wc/employer/).
      Do not interpret “not required in most cases” as an insurance recommendation.

- [ ] Verify driver authorization, license status, commercial/personal auto
      coverage, vehicle/trailer registration, inspection, secure chemical/equipment
      transport, spill kit, first aid, and daily equipment inspection.

- [ ] Record manufacturer model/serial, manual revision, maintenance interval,
      inspection, defect/tag-out, and repair. Never let AI infer equipment safety
      from age or appearance.

## Communications, reviews, and privacy

- [ ] **REQUIRED COMMUNICATIONS LEGAL REVIEW.** Counsel must approve capture of
      SMS/voice/email consent, quiet hours, caller identification, prerecorded/AI
      voice disclosures, call recording, campaign eligibility, do-not-call
      screening, opt-out keywords, confirmation messages, and retention. A customer
      inquiry is not blanket consent for every channel or campaign.

- [ ] Suppress marketing immediately when any reasonable opt-out is received,
      retain the consent/opt-out audit record, and require owner approval for any
      suppression override. Review the FCC’s consent-revocation order
      [FCC 24-24](https://docs.fcc.gov/public/attachments/FCC-24-24A1_Rcd.pdf)
      together with the current, narrow waiver in
      [DA 26-12](https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf).
      As of this checklist’s verification date, DA 26-12 extends only the
      cross-category portion of 47 CFR 64.1200(a)(10) through January 31, 2027;
      it does not suspend other consent or revocation duties. Counsel must confirm
      the rule and any later FCC action before live messaging.

- [ ] **REQUIRED COMMUNICATIONS LEGAL REVIEW.** Apply the FTC’s current
      commercial-email requirements, including truthful routing/subject information,
      address disclosure, an understandable opt-out method, prompt honoring, and
      vendor monitoring:
      [FTC CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).

- [ ] Ask every completed customer for an honest review using the same neutral
      workflow. Do not suppress negative customers or condition a reward on positive
      sentiment. **REQUIRED LEGAL REVIEW:** review incentives and referral wording
      against the
      [FTC Consumer Reviews and Testimonials Rule Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)
      and each platform’s current terms. Negative-review replies require owner
      approval.

- [ ] **REQUIRED PRIVACY LEGAL REVIEW.** Publish counsel-approved privacy and
      retention notices and a request channel. Determine applicability of the Texas
      Data Privacy and Security Act using the
      [Texas Attorney General’s official overview](https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint/consumer-privacy-rights/texas-data-privacy-and-security-act).
      Do not infer exemption solely from employee count or revenue.

## Production readiness sign-off

| Evidence                                             | Owner | Reviewer                            | Date | Link / record ID |
| ---------------------------------------------------- | ----- | ----------------------------------- | ---- | ---------------- |
| Entity, assumed name, and contracts                  |       | Texas attorney                      |      |                  |
| Tax classification, permit, and price-book tax rules |       | Texas CPA/tax professional          |      |                  |
| Municipality/permit matrix                           |       | Attorney + municipal authorities    |      |                  |
| Wastewater and chemical program                      |       | Environmental/safety reviewer       |      |                  |
| Insurance binders and exclusions                     |       | Licensed insurance agent + attorney |      |                  |
| Communications/recording/marketing policy            |       | Attorney                            |      |                  |
| Privacy/retention/breach plan                        |       | Attorney/security reviewer          |      |                  |
| Sandbox golden-path proof                            |       | Owner                               |      |                  |
| Backup/restore drill                                 |       | Owner/technical operator            |      |                  |
| Live-provider health and webhook validation          |       | Owner/technical operator            |      |                  |

No live launch is approved until every required reviewer signs and every hard
gate has attached evidence in the approval/audit trail.
