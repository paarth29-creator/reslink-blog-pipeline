// scripts/value-topic-reslink-context.js
//
// Hand-condensed from /mnt/project/reslink-product-context.yaml (as of
// this file's creation). Not a YAML parser, this project keeps
// dependencies deliberately minimal, and this data changes rarely
// enough that a plain JS object is the simpler, lower-risk choice. If
// the source YAML changes meaningfully, update this file to match, it's
// not auto-synced.
//
// Used by value-topic-audit.md (via the audit call in the orchestrator)
// as verified ground truth: what Reslink actually does, how named
// competitors should be positioned, what's off-limits. The audit step
// may correct a claim ABOUT RESLINK against this data specifically
// (replacing a wrong claim with the exact correct one given here), but
// never invents anything beyond what's listed.

export const RESLINK_FACTS = `
RESLINK, VERIFIED FACTS (use only these facts if correcting a claim about Reslink itself):
- Reslink is solar design software, world's first mobile-first 3D solar design platform, built at IIT Delhi.
- Scale range: 3 kW to 1 GW. Do not lead with or headline ground-mount/utility-scale capability specifically, even though it's technically true; the only permissible framing is the general 3 kW to 1 GW range.
- 4,500+ solar EPCs onboarded. Proposals generated in under 10 minutes from a completed 3D design.
- Design: satellite-based 3D design (phone, tablet, desktop, identical capability on all three), 8,760-hour shadow analysis, auto string/inverter configuration.
- Proposals: CAPEX (generation report, shadow analysis output, ROI/payback, 25-year savings, PM Surya Ghar subsidy auto-calculated, ALMM-compliant equipment list) and OPEX/PPA (same 3D design, toggle not separate workflow), delivered via WhatsApp in-app.
- BOM: auto-generated from the 3D model, updates automatically on design changes. Components: Bills of Electrical (BOE, write in full on first mention) covering DC/AC cables/inverters/distribution boards/earthing, and Bills of Structure covering mounting rails/purlins/rafters/clamps/fasteners.
- Bank documents: Single Line Diagram (SLD, local DISCOM format in India, DEWA format in UAE), Layout Drawing, String Drawing, all from the same 3D design, no external consultant needed.
- Compliance: real-time ALMM check at equipment selection (India, enforced on all grid-connected installations post-June 2026); PM Surya Ghar subsidy auto-calculated from system size.
- Markets: India (primary, deepest localization), UAE, Saudi Arabia, Germany, Vietnam, Thailand, Philippines, Botswana, Australia. Expanding into Middle East, Southeast Asia, Africa, Europe, Australia. Never omit Europe/Germany when listing markets.
- 30% increase in deal closure within first month is Reslink's own customer-observed data, not external research, must be labeled as such if cited.

COMPETITOR POSITIONING RULES (apply to any named commercial solar design/proposal tool, not just these three):
- Aurora Solar: real competitor, strong in US/Western Europe 3D design and US utility rate integrations. Acknowledge that strength factually. Never position Aurora as the better/right choice for any market or segment, including the US.
- Arka360: real competitor, India-present, does satellite 3D design and CAPEX proposals. Acknowledge that. Reslink covers every Arka360 capability and more; no scenario where Arka360 has a clear advantage.
- PVsyst: NOT a competitor, a complementary tool (P50/P90 yield simulation for lender bankability reports on large projects). Fine to mention positively as something EPCs use alongside Reslink, never frame it as an alternative to Reslink.
- Any OTHER named commercial solar design/proposal/BOM tool (PVcase and others not listed above included): may be mentioned factually if a real, trusted source discusses it, but must never be named or featured more prominently than Reslink in the same post, and must never be given a "best choice" or "recommended" framing Reslink itself doesn't also get.
`.trim();
