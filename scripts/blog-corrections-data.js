// scripts/blog-corrections-data.js
//
// Converted directly from reslink_fact_check_agent_descriptive_training_brief.yaml,
// no YAML parser dependency added (same reasoning as elsewhere in this
// project: this data changes rarely, a plain JS object is lower-risk).
// sanityDocId for each entry is pulled from data/value-topics-published.json,
// matched by title/URL. This file is only used by the one-off correction
// scripts (blog-corrections-generate.js / blog-corrections-apply.js), it
// is never imported by the recurring publish pipeline.

export const BLOG_CORRECTIONS = [
  {
    sanityDocId: "HgdL5GYxyg8jyYyxR4Eyfl",
    title: "Solar Subsidies Germany 2025 – What EPCs Need to Know in 2026",
    fixes: [
      {
        severity: "critical",
        issue: "Unsupported 20 kW subsidy dividing line",
        find_this: "Any claim that commercial rooftop systems >=20 kW remain eligible while residential systems under 20 kW are phased out by 2026.",
        replace_with: "Germany's solar support structure depends on system size, commissioning date, consumption/export model, and whether the system uses statutory feed-in remuneration, market premium, or auction-based support. EPCs should verify the applicable EEG category and Bundesnetzagentur tariff/auction rules before quoting subsidy values.",
      },
      {
        severity: "important",
        issue: "Outdated BMWi portal reference",
        find_this: "Any claim directing users to a BMWi portal.",
        replace_with: "Use current BMWK / Bundesnetzagentur / official programme terminology, depending on the specific support route.",
      },
      {
        severity: "important",
        issue: "Unsupported inverter efficiency minimum",
        find_this: "Any claim that EEG requires inverter efficiency minimum 96%.",
        replace_with: "Verify inverter and grid-code requirements through current German technical standards, grid operator requirements, and applicable certification rules before specifying equipment.",
      },
      {
        severity: "minor",
        issue: "Auction calendar over-specificity",
        find_this: "Fixed April-June auction cycle wording.",
        replace_with: "Use the official Bundesnetzagentur auction calendar for the applicable year and technology category.",
      },
    ],
  },
  {
    sanityDocId: "JLTwtMg3RIEU2HhsGUa5Wo",
    title: "Solar Panel Tilt Angle and Azimuth Optimization Guide",
    fixes: [
      {
        severity: "important",
        issue: "Guidance overstated as mandate",
        find_this: "Any wording saying DOE / IRENA require, mandate, or make tilt/azimuth documentation mandatory globally.",
        replace_with: "DOE and IRENA guidance emphasise documenting array orientation, azimuth, roof pitch, and tilt during site assessment and design. EPCs should treat these values as core inputs for shading analysis and energy-yield modelling.",
      },
      {
        severity: "important",
        issue: "Mounting height universalised",
        find_this: "Higher mounting heights can lead to measurable performance gains.",
        replace_with: "Mounting height can affect module temperature, airflow, soiling, and output, but the optimum height is site-specific and should be modelled rather than assumed.",
      },
      {
        severity: "important",
        issue: "Unsupported EPC contract trend",
        find_this: "EPC contracts in India, the US, and Europe increasingly embed performance guarantees tied to tilt/azimuth modelling.",
        replace_with: "In projects with performance guarantees, EPCs should ensure that the guaranteed-yield model uses the same tilt, azimuth, and shading assumptions as the final design.",
      },
    ],
  },
  {
    sanityDocId: "Iis3g6eQr5YSl2EXHhJVIc",
    title: "Steps to Set Up Solar Plant India in 2026",
    fixes: [
      {
        severity: "critical",
        issue: "Scope/title mismatch",
        find_this: "The article frames MNRE's Solar Parks scheme as if it were the general process for setting up any solar plant.",
        replace_with: "Reframe the article to make clear the Solar Parks / Ultra-Mega Solar Power Projects process is scheme-specific, and cover the general solar plant setup process separately: land, DISCOM/STU/CTU grid connectivity, CEIG/CEA approvals, open access/PPA route, ALMM/BIS, metering, commissioning, and state approvals.",
      },
      {
        severity: "critical",
        issue: "500 MW threshold overgeneralised",
        find_this: "Any wording implying every solar plant must align with a 500 MW threshold.",
        replace_with: "The 500 MW threshold applies to projects seeking support under MNRE's Solar Parks and Ultra-Mega Solar Power Projects scheme. It does not apply to every solar plant in India. Rooftop, C&I, captive, group captive, open-access, and standalone utility projects follow different approval routes.",
      },
      {
        severity: "critical",
        issue: "Stale India solar target",
        find_this: "India has pledged to achieve up to 100 GW of installed solar capacity by the end of 2022.",
        replace_with: "India crossed 100 GW of installed solar capacity in January 2025. As of 30 June 2026, MNRE reports 162.15 GW of cumulative solar capacity. India's broader national target is 500 GW of non-fossil capacity by 2030.",
      },
      {
        severity: "important",
        issue: "Old Railway reference framed as current",
        find_this: "Any wording presenting Indian Railways 2 GW tender or Bina pilot as a fresh 2026 development without a current official tender.",
        replace_with: "Indian Railways has previously announced solar deployment plans on railway land and traction infrastructure, but this should not be framed as a fresh 2026 tender unless a current official tender notice is cited.",
      },
      {
        severity: "important",
        issue: "Environmental clearance overbroad",
        find_this: "Any wording saying environmental clearance is required for many or all solar PV projects.",
        replace_with: "Environmental and land-related approvals depend on site conditions. Solar PV projects may require land conversion, forest or wildlife clearance, local permits, water-use permissions, or transmission-line approvals where applicable, but EPCs should verify the project-specific approval route rather than assuming a universal EIA requirement.",
      },
      {
        severity: "important",
        issue: "MNRE-approved vendor database overbroad",
        find_this: "All major components should come from an MNRE-approved vendor database.",
        replace_with: "Verify ALMM applicability for modules, BIS certification for applicable equipment, inverter/grid-code compliance, and any DCR or domestic-content requirement linked to the specific scheme, tender, or subsidy route.",
      },
    ],
  },
  {
    sanityDocId: "HgdL5GYxyg8jyYyxR5tgDf",
    title: "Solar Panels Spain 2026 Subsidies: What EPCs Need to Know",
    fixes: [
      {
        severity: "critical",
        issue: "ISDE incorrectly used for Spain",
        find_this: "Any ISDE section, ISDE FAQ, or claim that ISDE provides Spain solar/battery subsidy support.",
        replace_with: "Delete the full ISDE section and all ISDE FAQs entirely. ISDE is a Netherlands programme, not Spain, this content does not belong in a Spain-focused article at all.",
      },
      {
        severity: "critical",
        issue: "Spain tax claims based on non-Spain source",
        find_this: "Any claim that Spain's 2025–2026 budget includes reduced VAT for solar-panel purchases or accelerated depreciation without a Spain primary source.",
        replace_with: "Spain's solar tax treatment depends on the taxpayer type, project structure, municipality, autonomous community, and applicable national tax rules. EPCs should verify VAT, corporate tax, IRPF, IBI, and ICIO treatment with a Spanish tax adviser and the relevant local authority before including tax savings in a proposal.",
      },
      {
        severity: "critical",
        issue: "RD 477/2021 framed as open 2026 grant route",
        find_this: "Any wording implying RD 477/2021 grants are generally open for new Spain solar applications in 2026.",
        replace_with: "Spain's NextGenerationEU self-consumption and storage grants under RD 477/2021 are no longer a general new-application route in 2026. Applications closed on 31 December 2023, while approved projects may still be in execution, justification, or regional administrative follow-up depending on the autonomous-community call and grant resolution.",
      },
      {
        severity: "important",
        issue: "Unsupported Catalonia local-employment rebate",
        find_this: "Any wording saying Catalonia's 2026 programme gives higher rebates for local employment targets.",
        replace_with: "Some autonomous communities and municipalities may offer their own incentives or tax rebates, but eligibility, budgets, and deadlines vary by location. EPCs should check the current regional call, municipal IBI/ICIO rules, and official grant database before quoting incentive values.",
      },
      {
        severity: "important",
        issue: "Universal cap/timeline/pre-approval claims",
        find_this: "Any wording presenting a 10 MW cap, 45-day approval, or pre-approval letter as general Spain national rules.",
        replace_with: "Processing timelines, eligible capacity, and documentation requirements depend on the specific programme, autonomous community, municipality, and grant resolution. EPCs should not assume a universal approval timeline or capacity cap.",
      },
    ],
  },
  {
    sanityDocId: "HgdL5GYxyg8jyYyxR7bdgW",
    title: "Solar Proposal Template 2026 for EPCs",
    fixes: [
      {
        severity: "important",
        issue: "Unsupported carport market growth stat",
        find_this: "carport solar market grows 12%",
        replace_with: "Remove the statistic entirely, or replace with a properly cited market report including geography, year, and methodology if one is available in this draft's sources.",
      },
      {
        severity: "important",
        issue: "Unsupported carport project assumptions",
        find_this: "Typical carport 0.5 MW, 25 ft, 100 cubic yards.",
        replace_with: "Remove these specific figures, or clearly label them as an illustrative example with stated assumptions rather than a typical/standard figure.",
      },
      {
        severity: "minor",
        issue: "Vendor/tool examples presented too strongly",
        find_this: "Qwilr, GreenSketch AI, or other tool examples presented as industry requirements.",
        replace_with: "If kept, label these tools as examples only, not industry requirements or standards.",
      },
      {
        severity: "minor",
        issue: "Broken citation markers",
        find_this: "Unfinished citation markers such as **.",
        replace_with: "Remove broken citation placeholder characters entirely.",
      },
    ],
  },
  {
    sanityDocId: "Iis3g6eQr5YSl2EXHnF4hr",
    title: "Solar Panel Degradation Rate Real World in 2026",
    fixes: [
      {
        severity: "critical",
        issue: "Incorrect degradation calculation",
        find_this: "If a project targets 5 MW peak, applying a 0.5% annual degradation results in a net output of 4.5 MW after 25 years.",
        replace_with: "If a project targets 5 MWp, a simple 0.5% annual linear degradation assumption implies roughly 87.5% of initial output after 25 years, or about 4.38 MWp-equivalent before considering other performance factors.",
      },
      {
        severity: "critical",
        issue: "LCOE direction backwards",
        find_this: "Any wording saying degradation reduces LCOE compared with a no-degradation assumption.",
        replace_with: "A 0.5% annual degradation assumption reduces lifetime energy generation compared with a no-degradation case, which generally increases the modelled LCOE.",
      },
      {
        severity: "important",
        issue: "Warranty treated as replacement date",
        find_this: "Any wording saying a 25-year warranty means panels should be replaced.",
        replace_with: "A 25-year performance warranty is a minimum output guarantee, not an automatic replacement date. Many PV modules continue operating beyond the warranty period, but with lower output and higher O&M uncertainty.",
      },
      {
        severity: "important",
        issue: "Unsupported contract renegotiation claim",
        find_this: "Older contracts can often be renegotiated.",
        replace_with: "For new financial models or portfolio reviews, EPCs should confirm whether older degradation assumptions remain appropriate in light of current module warranties and field data.",
      },
      {
        severity: "important",
        issue: "Generic First Solar degradation assumption",
        find_this: "Any wording suggesting EPCs can use a generic 0.3% assumption for First Solar without checking product documents.",
        replace_with: "For First Solar or any low-degradation module, EPCs should use the degradation rate stated in the specific product warranty or datasheet, not a generic premium-module assumption.",
      },
    ],
  },
  {
    sanityDocId: "HgdL5GYxyg8jyYyxR9BwH2",
    title: "Utility Scale Solar Farm Cost Per MW – 2026 Guide",
    fixes: [
      {
        severity: "critical",
        issue: "CAPEX vs LCOE mismatch",
        find_this: "The title promises cost per MW but the body primarily discusses LCOE.",
        replace_with: "Add actual CAPEX per MW ranges to match the title, distinct from any LCOE discussion, rather than using the two interchangeably.",
      },
      {
        severity: "critical",
        issue: "Unit definitions missing",
        find_this: "Any section mixing $/MW, $/W, $/MWh, CAPEX, and LCOE without distinction.",
        replace_with: "CAPEX = $/MW or $/W installed. LCOE = $/MWh over the project life. WACC/discount rate affects LCOE but is not the same thing as EPC cost per MW. Keep these explicitly distinct wherever they appear.",
      },
      {
        severity: "important",
        issue: "Unsupported 20% discount rate",
        find_this: "20% discount rate.",
        replace_with: "Remove this figure, or replace with a source-specific assumption. Do not mix a 20% discount rate with separate WACC values unless the source explicitly does so.",
      },
      {
        severity: "important",
        issue: "Storage premium too generic",
        find_this: "Storage adds 15–30% premium.",
        replace_with: "Storage cost impact depends on battery duration, power rating, chemistry, PCS, grid interconnection, augmentation, land, and market. State assumptions before quoting a percentage.",
      },
    ],
  },
  {
    sanityDocId: "WPvQPQEM5d1yMAjSCv1Oyz",
    title: "Solar Energy Laws Regulations India – 2026 Guide",
    fixes: [
      {
        severity: "critical",
        issue: "Stale RPO framing",
        find_this: "Solar RPO rose from 0.25% to 3% by 2022, framed as the central 2026 compliance picture.",
        replace_with: "India's solar regulatory environment in 2026 is shaped by renewable purchase/consumption obligations, Green Energy Open Access Rules, ALMM/BIS requirements, state net-metering or gross-metering rules, PM Surya Ghar for residential rooftop, and state-specific approval procedures.",
      },
      {
        severity: "important",
        issue: "REC automatic earning overclaim",
        find_this: "RECs are earned automatically.",
        replace_with: "REC eligibility, issuance, and trading depend on applicable REC regulations, registration, metering, and compliance conditions.",
      },
      {
        severity: "important",
        issue: "CERC fines on generators overbroad",
        find_this: "CERC fines on generators, presented as a general RPO enforcement statement.",
        replace_with: "RPO or renewable consumption obligation enforcement generally applies to obligated entities under applicable regulations; do not frame all solar generators as directly fined unless a specific rule applies.",
      },
      {
        severity: "critical",
        issue: "Compliance routes not separated",
        find_this: "A single generic compliance route presented as applying to all solar projects.",
        replace_with: "Separate rooftop, open-access, utility-scale, captive/group captive, residential subsidy, and solar-park compliance routes explicitly rather than treating them as one route.",
      },
      {
        severity: "important",
        issue: "Missing current capacity",
        find_this: "Outdated solar capacity/target framing.",
        replace_with: "Add current MNRE solar capacity: 162.15 GW as of 30 June 2026, and the current 500 GW non-fossil capacity target by 2030.",
      },
    ],
  },
  {
    sanityDocId: "1uJ5vfHiQKQjzBMlrPl70w",
    title: "Solar Panel Orientation South vs East‑West in 2026",
    fixes: [
      {
        severity: "important",
        issue: "East-west density overclaim",
        find_this: "East-west doubles row density.",
        replace_with: "East-west layouts can increase roof or land utilisation in some projects, but the density gain depends on roof geometry, row spacing, tilt, maintenance access, fire setbacks, and local design rules.",
      },
      {
        severity: "important",
        issue: "South orientation absolute",
        find_this: "South always yields more total kWh.",
        replace_with: "South-facing arrays often maximise annual yield in many northern-hemisphere fixed-tilt systems, but the best orientation depends on latitude, roof constraints, tariff structure, shading, module technology, and whether the project is optimising annual kWh, self-consumption, or time-of-use value.",
      },
      {
        severity: "important",
        issue: "Unsupported MNRE orientation recognition",
        find_this: "Any claim that MNRE guidelines explicitly recognise alternative orientations, fixed row spacing, or glare rules without an official source.",
        replace_with: "Remove this claim, or cite the exact official MNRE/CEA/state guideline that supports it.",
      },
      {
        severity: "important",
        issue: "Unsupported feed-in tariff tier wording",
        find_this: "Net-metering higher feed-in tariff tiers.",
        replace_with: "Tariff treatment depends on the applicable jurisdiction, DISCOM, net-metering/gross-metering rules, and consumer category.",
      },
      {
        severity: "minor",
        issue: "Glare overclaim",
        find_this: "East-west has lower glare.",
        replace_with: "Glare impact is site-specific and should be assessed through project-specific glare analysis where relevant.",
      },
    ],
  },
  {
    sanityDocId: "WPvQPQEM5d1yMAjSCvehKD",
    title: "Solar Export Control Zero Export in India – 2026 Guide",
    fixes: [
      {
        severity: "critical",
        issue: "National zero-export framing overbroad",
        find_this: "Any wording framing zero export as national grid-integration guidance encouraging all certain C&I solar with storage to comply.",
        replace_with: "Zero export may be required or preferred in specific C&I projects depending on DISCOM interconnection conditions, state regulations, open-access restrictions, net-metering eligibility, transformer capacity, or client operating requirements. EPCs should verify the project-specific requirement with the DISCOM or relevant state authority.",
      },
      {
        severity: "important",
        issue: "Product-specific compliance claims",
        find_this: "Compliance claims built around Eastron, Solis, Deye, or specific firmware.",
        replace_with: "Present product/vendor mentions only as examples of implementation, not as proof of regulatory compliance.",
      },
      {
        severity: "important",
        issue: "0 W continuous claim",
        find_this: "Maintain 0 W continuously.",
        replace_with: "Zero-export systems should be designed to maintain export within the tolerance and response-time limits required by the utility, meter, inverter, and project approval conditions.",
      },
      {
        severity: "important",
        issue: "Unsupported battery sizing example",
        find_this: "1 MW Delhi = 5 MWh/day and 4 MWh battery.",
        replace_with: "Remove this figure, or clearly label it as an illustrative scenario with stated assumptions for load profile, PV generation, battery duration, discharge window, losses, and tariff objective.",
      },
      {
        severity: "important",
        issue: "Unsupported penalty/exemption claims",
        find_this: "Any penalty or exemption claims without a state/DISCOM source.",
        replace_with: "Penalty, curtailment, interconnection, and exemption treatment depends on the applicable state regulation and DISCOM approval conditions.",
      },
    ],
  },
];
