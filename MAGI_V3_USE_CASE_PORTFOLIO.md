# MAGI V3 Use Case Portfolio

## Purpose
This document expands high-value MAGI V3 mission types to stress-test product design, agent architecture, and operations.

Each use case is defined with:
- mandate and success KPIs
- team roles
- core workflows
- work products
- cadence
- data sensitivity and approvals
- failure and alert conditions
- V3 MVP scope

## 1) Equity Research Team
### Mandate
Monitor a sector or country, maintain investment theses, and publish daily and weekly intelligence.

### Team roles
- Lead Analyst
- Junior Analyst(s)
- Data Scientist(s)
- Watcher/Alert Agent

### Core workflows
- Source ingestion (earnings, filings, macro releases, news)
- Thesis update and signal scoring
- Quant analysis and chart generation
- Alerting on material events

### Work products
- Daily market brief
- Weekly sector report
- Event-driven alerts with confidence and rationale
- Evidence-linked charts/tables

### Cadence
- Daily scheduled runs + intraday event triggers

### KPIs
- Report freshness SLA
- Alert precision/recall
- Citation coverage per report

### Sensitivity and approvals
- Medium sensitivity
- Human approval for externally shared outputs

### Failure and alert conditions
- Source feed outage
- Contradictory signals above threshold
- Missed publish SLA

### V3 MVP scope
- Full vertical slice in early sprints (primary anchor scenario)

## 2) Thesis Copilot Team
### Mandate
Support a student through thesis planning, literature review, data analysis, and writing improvement.

### Team roles
- Supervisor Agent (planning and checkpoints)
- Literature Agent
- Data Analysis Agent
- Writing/Style Reviewer
- Citation Integrity Agent

### Core workflows
- Build research plan and milestones
- Collect and summarize papers
- Clean/analyze datasets
- Review chapter drafts

### Work products
- Weekly thesis progress report
- Annotated bibliography
- Draft chapter review notes
- Reproducible analysis notebooks

### Cadence
- Weekly planning + on-demand writing reviews

### KPIs
- Milestone completion rate
- Citation consistency rate
- Draft revision turnaround

### Sensitivity and approvals
- Medium sensitivity (student data + draft IP)
- Student controls publication/export

### Failure and alert conditions
- Reference mismatch detected
- Analysis notebook fails reproducibility check
- Missed milestone checkpoint

### V3 MVP scope
- Early secondary scenario to validate long-form writing workflows

## 3) Website Rebuild Delivery Team
### Mandate
Rebuild a company website from requirements to production-ready release artifacts.

### Team roles
- Product/Requirements Agent
- Frontend Engineer Agent
- Content Migration Agent
- QA/Test Agent
- Release Coordinator Agent

### Core workflows
- Requirement decomposition
- Component/page implementation
- SEO/accessibility validation
- Regression and performance testing

### Work products
- Code artifacts and PR-style patches
- Test reports
- Deployment checklist
- Release notes

### Cadence
- Continuous execution with daily status snapshots

### KPIs
- Story completion throughput
- Defect escape rate
- Lighthouse/accessibility score targets

### Sensitivity and approvals
- Medium to high (production credentials and brand assets)
- Mandatory human approval before deployment

### Failure and alert conditions
- Failing CI gate
- Accessibility/SEO score below threshold
- Blocked dependency or migration error

### V3 MVP scope
- Early validation of code execution and monitoring tools

## 4) Data Protection Officer (DPO) Operations Team
### Mandate
Automate regulatory watch and privacy operations: policies, RoPA, DSAR support, incident support.

### Team roles
- DPO Lead Agent
- Regulatory Watch Agent
- Policy Drafting Agent
- RoPA Maintenance Agent
- DSAR Workflow Agent
- Incident Triage Agent

### Core workflows
- Monitor new guidance/regulatory updates
- Draft/update internal policies
- Maintain processing register metadata
- Support DSAR intake and tracking
- Support privacy incident triage packs

### Work products
- Regulatory change digests
- Policy draft updates with diffs
- RoPA update proposals
- DSAR case summaries
- Incident response brief templates

### Cadence
- Daily watch + event-driven incident support

### KPIs
- Regulatory update latency
- Policy update cycle time
- DSAR SLA compliance

### Sensitivity and approvals
- High sensitivity (personal data, legal risk)
- Strict approval gates and audit trails

### Failure and alert conditions
- Missed legal deadline
- Policy/document inconsistency
- High-risk incident without owner acknowledgment

### V3 MVP scope
- Later phase due to compliance and controls complexity

## 5) Legal/Policy Drafting Team
### Mandate
Compare and draft policies/contracts, identify risks, and produce redline-ready recommendations.

### Team roles
- Lead Counsel Agent
- Clause Analysis Agent
- Risk Scoring Agent
- Drafting Agent

### Core workflows
- Clause extraction and comparison
- Risk tagging by policy framework
- Draft recommendation generation

### Work products
- Redline suggestions
- Risk summary memo
- Negotiation preparation notes

### Cadence
- On-demand per matter

### KPIs
- Review cycle time
- High-risk clause detection rate
- Reviewer acceptance rate

### Sensitivity and approvals
- High sensitivity
- Human legal sign-off always required

### Failure and alert conditions
- Missing required clause category
- Conflicting recommendations across agents

### V3 MVP scope
- Medium-term scenario for document reasoning quality

## 6) Procurement and Vendor Risk Team
### Mandate
Assess vendor risk posture and support procurement due diligence decisions.

### Team roles
- Procurement Lead Agent
- Questionnaire Analysis Agent
- Security/Privacy Risk Agent
- Financial Stability Agent

### Core workflows
- Parse vendor questionnaires
- Correlate with policy requirements
- Compute composite risk score

### Work products
- Vendor risk assessment report
- Gap list and remediation requests
- Decision recommendation packet

### Cadence
- Per procurement event + periodic vendor review

### KPIs
- Assessment turnaround time
- Evidence completeness score
- False-negative risk findings

### Sensitivity and approvals
- Medium to high sensitivity
- Approval gates for final vendor decision outputs

### Failure and alert conditions
- Missing evidence for critical controls
- Risk score model drift

### V3 MVP scope
- Mid-phase scenario to validate structured questionnaires and scoring

## 7) Product Intelligence Team
### Mandate
Track competitors, identify feature gaps, and recommend product strategy updates.

### Team roles
- Product Strategy Lead Agent
- Competitor Tracking Agent
- User Signal Agent
- Synthesis Agent

### Core workflows
- Monitor launches/roadmaps/public signals
- Cluster user feedback and demand themes
- Compare feature parity and priority

### Work products
- Monthly product intelligence brief
- Feature opportunity backlog
- Risk/opportunity map

### Cadence
- Weekly monitoring + monthly strategic synthesis

### KPIs
- Time-to-detect competitor moves
- Recommendation adoption rate
- Signal quality score

### Sensitivity and approvals
- Medium sensitivity
- Human PM approval for roadmap-impacting outputs

### Failure and alert conditions
- Missed major competitor launch
- Low-confidence recommendation spikes

### V3 MVP scope
- Mid-phase scenario for monitoring + synthesis balance

## 8) Marketing Content Operations Team
### Mandate
Plan campaigns, produce assets, and optimize performance loops.

### Team roles
- Campaign Lead Agent
- Content Production Agent
- Channel Optimization Agent
- Performance Analyst Agent

### Core workflows
- Campaign brief generation
- Content draft and variation generation
- Performance review and iteration

### Work products
- Campaign plans
- Channel-specific content sets
- Post-campaign analytics reports

### Cadence
- Weekly campaign cycles + daily performance checks

### KPIs
- Asset throughput
- Engagement/conversion lift
- Cycle time from brief to publish

### Sensitivity and approvals
- Medium sensitivity (brand and legal compliance)
- Approval gates for public-facing assets

### Failure and alert conditions
- Brand policy violations
- Underperforming campaign threshold breach

### V3 MVP scope
- Mid-phase scenario for high-volume content operations

## 9) Customer Support Optimization Team
### Mandate
Improve support quality by clustering issues, updating knowledge assets, and flagging recurring failures.

### Team roles
- Support Ops Lead Agent
- Ticket Clustering Agent
- Knowledge Base Agent
- Escalation Watch Agent

### Core workflows
- Cluster ticket themes
- Propose KB updates
- Detect incident-like ticket spikes

### Work products
- Weekly support intelligence report
- Proposed KB changes
- Escalation alerts

### Cadence
- Daily triage + weekly synthesis

### KPIs
- Mean time to resolution improvement
- Deflection rate via KB updates
- Repeat ticket reduction

### Sensitivity and approvals
- Medium to high (customer data)
- PII-aware redaction controls required

### Failure and alert conditions
- Spike in unresolved tickets
- Missing KB updates for recurring issues

### V3 MVP scope
- Later phase due to PII and integration complexity

## 10) Internal Audit Evidence Team
### Mandate
Continuously gather control evidence and prepare audit-ready packets.

### Team roles
- Audit Lead Agent
- Control Mapping Agent
- Evidence Collection Agent
- Exception Tracking Agent

### Core workflows
- Map controls to evidence requirements
- Collect and validate evidence artifacts
- Track exceptions and remediation

### Work products
- Audit evidence binder
- Exception register
- Readiness scorecard

### Cadence
- Continuous collection + periodic readiness reviews

### KPIs
- Evidence completeness
- Exception closure time
- Audit prep effort reduction

### Sensitivity and approvals
- High sensitivity
- Strict immutable audit trails

### Failure and alert conditions
- Evidence aging beyond threshold
- Missing owner for open exception

### V3 MVP scope
- Later phase due to strict auditability requirements

## 11) Academic Research Paper Team (New)
### Mandate
Support a researcher from idea to submission-ready paper with strong reference management, annotation, and mathematical rigor.

### Team roles
- Research Lead Agent
- Reference Librarian Agent
- Annotation and Evidence Agent
- Methods/Math Agent
- Writing and Structure Agent
- Reproducibility Agent

### Core workflows
- Build and maintain a curated bibliography
- Ingest and annotate papers with structured notes
- Track claims and supporting references
- Draft sections with citation-aware writing
- Validate equations/notation and reproducibility artifacts

### Work products
- Living reference database (BibTeX/CSL JSON compatible)
- Annotated reading notes with tags and relevance scores
- Claim-to-citation matrix
- Paper draft with section-level evidence mapping
- Math appendix and reproducibility bundle (code, data, environment notes)

### Cadence
- Daily reading/annotation loop
- Weekly synthesis and draft revisions
- Pre-submission validation run

### KPIs
- Citation coverage per claim
- Orphan claim count (claims without references)
- Equation/notation consistency rate
- Reproducibility pass rate
- Draft readiness score

### Sensitivity and approvals
- Medium sensitivity (unpublished IP)
- Human researcher approval for manuscript export/submission

### Failure and alert conditions
- Duplicate or broken references
- Citation drift after draft edits
- Equation symbol inconsistency across sections
- Reproducibility check failures

### V3 MVP scope
- Early-to-mid phase scenario for deep writing + citation + math workflows

### Special capability requirements
- Reference manager support:
  - import from DOI/arXiv/manual entries
  - deduplication and canonical citation keys
  - export to BibTeX/CSL JSON
- Annotation system:
  - passage-level notes
  - tag taxonomy (method, limitation, dataset, finding)
  - quote extraction with source pointer
- Math support:
  - LaTeX equation editing assistance
  - symbol table and notation consistency checks
  - optional symbolic or numeric sanity checks for derivations
- Writing support:
  - section templates for introduction/method/results/discussion
  - argument coherence checks and gap detection
  - citation style compliance checks

## Cross-Use-Case Prioritization
### Phase 1 anchors (immediate)
- Equity Research Team
- Website Rebuild Delivery Team
- Academic Research Paper Team

### Phase 2 anchors (after core reliability)
- Thesis Copilot Team
- Product Intelligence Team
- Procurement and Vendor Risk Team

### Phase 3 anchors (strict governance)
- DPO Operations Team
- Legal/Policy Drafting Team
- Customer Support Optimization Team
- Internal Audit Evidence Team

## Product and Architecture Implications
- A strong mailbox and artifact model is required across all use cases.
- Work Product Layer UI should be domain-adaptable but share core surfaces:
  - inbox
  - reports
  - alerts
  - Q&A with citations
  - evidence lineage
- Governance controls must be policy-driven, with stricter defaults in high-sensitivity domains.
- Evaluation must include both generic metrics (freshness, reliability, cost) and domain KPIs.
