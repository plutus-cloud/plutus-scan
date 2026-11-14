# plutus-scan: design

## Intent

A free, open-source CLI that answers one question fast and credibly: **what changed in my
cloud and AI bill, and where?** An engineer with AWS CLI access runs it once and gets a terminal
summary that leads with that answer, a self-contained offline HTML report they can send to
finance, and a Markdown summary they can paste into Slack or a PR. It is useful on its own.
The questions it leaves open (who owns this AI project, is this candidate actually waste, what
happens tomorrow) are what hosted Plutus answers, and the only mention of that is one footer
line.

Why this shape: one sharp question answered by one `npx` command, with no setup. Every
addition below serves "what changed and where", and the trust features lead the README.

## The first-run user

An engineer on AWS with working `aws` CLI credentials (profile, SSO or env vars) and no billing
export set up, possibly with an OpenAI or Anthropic admin key. They type:

```
npx plutus-scan
```

and within a minute have the answer: the terminal summary, then the HTML report opened in their browser. FOCUS exports are the opt-in path for Azure, GCP, OCI and
anyone who already has one.

## Goals

- Zero-setup AWS from `aws` CLI credentials alone, with permission errors that name the fix.
- OpenAI and Anthropic spend by model and by project or workspace, on the same chart as cloud.
- A headline block, first in every output, that a person can quote as text.
- Drivers drilled to usage type, so "EC2-Other" becomes "NatGateway-Bytes".
- Billing-derived "candidates to review", sized in dollars, never called proven savings. One figure
  may say "Possible savings", and only as a ceiling: "up to" the last 30 days of spend on the
  "Often worth changing" candidates, with a line beside it saying the bill cannot show whether any of
  it is waste. A line cannot save more than it costs, so the ceiling is true; the label stays honest
  only while the figure is the ceiling and the caveat stays next to it.
- Credibility: cost basis, credits and tax, last complete day, stated on every output.
- Trust is a feature: no telemetry, `--dry-run`, the CSP-locked HTML, calls only to providers
  the user named, one runtime dependency.
- A small keyboard-only TUI (`--tui`) for drilling down without re-running. The plain summary stays the
  default, and the TUI is opt-in.

## Non-goals

- Live Azure, GCP or OCI APIs (FOCUS file only).
- A forecast panel with a band (the month-end projection stays, as a headline number and a
  dashed extension on the daily chart).
- Per-team or per-customer allocation, tag rules, budgets, alerts, history, multi-user, unit
  economics, MCP, tagging or allocating AI spend. That is Plutus.
- API-key-level AI attribution (unreliable in both APIs).
- A `serve` mode, writing to any system, Kubernetes, SaaS sources beyond OpenAI and Anthropic,
  uploading to Plutus (design the JSON for a future `--upload`, don't build it).
- Snapshot history and `--compare`, a Rust binary, a share card: later.

## Anti-goals

- Anything leaves the machine that the user didn't name: plutus-cloud.com, a font, a CDN, an
  update check.
- A credential written to disk, logged, or embedded in any output.
- A "pro" flag, license key, nag screen or second promotional line. The footer is the one promotional
  line; the only other mention of Plutus is the factual pull-request pointer on the one candidate it can
  fix (see Candidates to review), which names no price, plan or quota and promises no saving, and the single bare URL line that ends
  the terminal candidates section when such a candidate is shown.
- It looks like a cut-down Plutus (React, Recharts, the app's chrome). No Ink either.
- A candidate presented as proven savings, or a savings figure that is not the ceiling described above.
- A surprise AWS bill.

## Stack

- npm package `plutus-scan`, MIT.
- Node >= 20, plain ESM JavaScript with JSDoc, no build step, tests on `node:test`. Node over
  Rust: the analysis is adapted from Plutus's backend rather than ported, and distribution in
  this niche is `npx`.

## Inputs

### AWS (default, live), through the user's `aws` CLI

The tool shells out to `aws` instead of bundling the SDK, so it never touches AWS credentials,
inherits SSO, profiles and MFA, stays at
zero dependencies, and `--dry-run` can print exact commands. Requires `aws` v2 on PATH; if
missing, AWS is skipped with an explanation.

AWS runs when `aws sts get-caller-identity` succeeds, unless `--no-aws`, or a FOCUS input
already holds AWS rows (then skipped with a note; `--aws` forces it). `--profile` passes
through.

Requests per run, each Cost Explorer call $0.01. There is no cap by default: every page of
results is fetched, because on an organisation account the daily query alone can need many
pages. `--max-aws-requests <n>` sets an optional cap. On it the tool stops, uses what it has, and
the note names what was skipped and whether the totals are complete, for example "AWS: stopped
at 20 Cost Explorer requests (--max-aws-requests); skipped tag coverage. Totals are complete."
("Totals are incomplete." when the daily query itself was cut):

1. Daily spend by `SERVICE` and `RECORD_TYPE` over the window (default 90 days, max 395),
   following `NextPageToken`. The record types `SavingsPlanRecurringFee`,
   `SavingsPlanUpfrontFee`, `RIFee`, `Recurring`, `Recurring reservation fee`, `Fee`, `Upfront`
   and `Upfront reservation fee` are commitment spend. Cost Explorer has spelled the reservation
   fees more than one way, so record types are compared without case, spaces or underscores.
   Every other record type (`Usage`, `DiscountedUsage`, `SavingsPlanCoveredUsage`,
   `SavingsPlanNegation`, `Tax`, `Credit`, `Refund`, `Support` and so on) is cloud. Groups are
   summed to one row per date, service and kind, except that `Credit` and `Refund` get a row of
   their own, so the anomaly baselines can leave them out. Savings Plan fees keep the Cost
   Explorer service name (`Savings Plans for AWS Compute usage`); the monthly reservation fees
   (`RIFee`, `Recurring`) become `<service> reservations`, and the fees charged on purchase
   (`Fee`, `Upfront`) become `<service> upfront fees`.
2. Drill-down: daily spend by `SERVICE` and `USAGE_TYPE` over the last 60 days, filtered to the
   top 3 AWS services by absolute 30-day change (commitment rows are not ranked) and excluding the
   commitment record types, so a usage driver's usage types never include its fees. A usage
   type that is a Reserved Instance fee (`HeavyUsage`) is skipped here and in the candidates
   whatever its record type.
3. Candidates: spend by `SERVICE` and `USAGE_TYPE` over the last 30 days, monthly granularity,
   excluding the commitment record types. This query is not limited to the top services the drill-down
   picks: every service on the bill is in it, so the rules for small services (a few secrets, one EKS
   cluster, a provisioned DynamoDB table) see their rows without any further request. Widening the rule
   table therefore adds no billed request; only a bill with very many usage types can add a page of
   results to this one query.
4. Active user cost allocation tags (`list-cost-allocation-tags`).
5. For each active tag key, up to 5: monthly spend grouped by that tag over the last 30 days;
   the empty value (`key$`) is untagged.

The drill-down filter is a Cost Explorer `And` of the service filter and a `Not` of the record
types:

```json
{"And":[{"Dimensions":{"Key":"SERVICE","Values":["<service>","<service>","<service>"]}},
        {"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["SavingsPlanRecurringFee",
          "SavingsPlanUpfrontFee","RIFee","Recurring","Recurring reservation fee","Fee",
          "Upfront","Upfront reservation fee"]}}}]}
```

The candidate query uses the `Not` expression on its own. The tag queries (step 5) also leave out
`SavingsPlanNegation`, `Tax`, `Credit` and `Refund`, which never carry a tag, and use `AmortizedCost`,
so the untagged share is usage only, like FOCUS tag coverage. Under UnblendedCost, Savings Plan
covered usage keeps its on-demand rate while its untagged negation row takes the whole discount to
the untagged side, which can make the share negative.

Typical run: 4-10 billed requests, more on organisation accounts with many services. `--help` and `--dry-run` state the price; every output states
the actual count and cost.

Errors that must be specific, not stack traces: access denied names `ce:GetCostAndUsage` and
the management-account rule for Organizations; Cost Explorer not enabled links the console. The
README carries a read-only IAM policy
(`ce:GetCostAndUsage`, `ce:ListCostAllocationTags`).

### OpenAI

`GET https://api.openai.com/v1/organization/costs`, `Authorization: Bearer $OPENAI_ADMIN_KEY`,
`start_time`/`end_time` unix seconds, `bucket_width=1d`, `group_by[]=line_item` and
`group_by[]=project_id`, `limit=180`, following `next_page`. If that combination returns 400,
retry with `line_item` alone and note that projects are unavailable. Amounts are dollars.
Project names from `GET /v1/organization/projects` (paged). Model = the line item's text before
the comma. A 404 gets a "check this is an admin key" message.

### Anthropic

`GET https://api.anthropic.com/v1/organizations/cost_report`, `x-api-key:
$ANTHROPIC_ADMIN_KEY`, `anthropic-version: 2023-06-01`, `starting_at`/`ending_at` RFC 3339,
`bucket_width=1d`, `group_by[]=description` and `group_by[]=workspace_id`, `limit=31`,
following `next_page`. `amount` is a decimal string in cents. Model = `model`, else
`description`, else `cost_type`. Workspace names from `GET /v1/organizations/workspaces`
(paged); a null workspace is "Default workspace". Priority Tier spend isn't in this API; every
output says so.

### FOCUS files

`--focus <path>`, repeatable: a file, a directory (recursive, `.csv`, `.csv.gz`, `.parquet`) or
an `s3://` prefix through `aws s3`. Streaming CSV parser adapted from Plutus; Parquet through
`hyparquet` (the one runtime dependency), uncompressed and Snappy only, with a clear re-export
message otherwise. Columns: `BilledCost`, `ChargePeriodStart`, `BillingCurrency` required;
`ServiceName`, `ServiceProviderName` falling back to `ProviderName`, `SubAccountName`/`Id`,
`ChargeCategory` (`Purchase` is commitment spend, labelled `<ServiceName> purchases`; the other
FOCUS 1.0 categories, Usage, Tax, Credit and Adjustment, are cloud), `Tags`, and usage type from `x_UsageType` falling back to
`ChargeDescription`. A row is AI rather than cloud when its provider or `PublisherName` is an AI
provider (OpenAI, Anthropic, Mistral AI, Cohere, AI21 Labs, xAI, Perplexity) or its
`ServiceCategory` is `AI and Machine Learning`; its project is the sub-account and its account is
null, as for the OpenAI and Anthropic sources, and it is left out of tag coverage. A `Purchase`
row stays a commitment. Rows with the same key are summed while reading, but a negative row (a
credit or refund) is kept apart from usage with the same key. Files in one directory (or one s3 prefix up to the last `/`) form one
export, and its part files are summed. Overlapping exports: per `(provider, day)` the export
with the newest file wins, with a warning.

### Demo (`--demo`)

`--demo` generates 90 days of synthetic spend for Example Corp, a fictional company, as a FOCUS
CSV from a fixed seed, and reads it through the FOCUS source, so a demo run takes the same path
as a real export. Every other source is off, it contacts nothing and reads no credentials, and
it refuses flags that would read an account. The data has scripted events that tests assert on:
one material one-day NAT gateway spike (the only anomaly), an RDS step that stays up (the top
mover, never flagged), a few-dollar KMS wobble below the floor, an upfront Reserved Instance
purchase and a monthly reservation fee on each 1st, and EBS snapshots kept in a dozen regions, so one
candidate has a long list of usage types. The gp2 series is at its natural size: candidates are ordered with the fixable kind first, so it needs no inflating to show. The README screenshot, the sample HTML
report and the terminal samples are drawn from it (`scripts/demo-report.js`).

### GitHub releases (optional)

`--github owner/repo` or `--github <owner>`, repeatable and mixed. Markers on the chart and
"nearest release" context on anomalies only; never a cost source.

- **One repo** (`owner/repo`): REST `GET /repos/<repo>/releases`, 100 a page, paged until a page
  starts before the window. A token is optional (it lifts the 60-an-hour unauthenticated limit).
- **Token**: the first of `--github-token`, `GITHUB_TOKEN`, `GH_TOKEN`, then the `gh` CLI's login,
  reused the way the AWS source reuses the `aws` CLI's (`src/sources/github-auth.js`). gh is asked
  only when a `--github` target is given, no token is set, `--no-gh-auth` is absent and `gh` is on
  PATH: `gh auth token --hostname github.com` through `execFile` by the absolute path found (relative
  PATH entries such as `.` are skipped; no shell, prompts off, the OpenAI and Anthropic keys left out
  of its environment, 5 s timeout, stderr dropped), output trimmed and accepted only as one printable, space-free line. A missing gh,
  a non-zero exit, a timeout or empty output all mean no token, never an error. `--demo` refuses the
  GitHub flags, so it never runs gh. It runs before `--dry-run` too, since it is local and decides
  whether org mode is refused; dry-run then shows `credential: gh login`. The token is only ever put
  in the `Authorization` header: the transport log, `--dry-run`, the notes ("GitHub: read with a
  token via gh login.") and the progress line ("3 requests via gh login") carry where it came from.
- **An org or user** (no slash): GraphQL, so a token is required; without one the run is refused
  before any request (GraphQL needs a token, and unauthenticated REST allows 60 requests an hour),
  with a message that suggests `gh auth login` as well as `GITHUB_TOKEN`.
  `organization(login)` first, then `user(login)` (with `ownerAffiliations: [OWNER]`) when the org
  query returns NOT_FOUND; neither is a note, not a failure. Each call reads
  `repositories(first: 100, isArchived: false, isFork: false, after:)` with each repo's
  `releases(first: 20, orderBy: CREATED_AT DESC)` inline. A repo is paged further (100 at a time,
  `repository(owner, name)`) only while its last page was full and its oldest release is still inside
  the window. Archived, forked and `--github-exclude` repos are dropped again client-side, as are a
  user's collaborations. A repo also named as `owner/repo` is not read twice.
- **Which releases**: drafts skipped; prereleases kept (often what a staging stack runs); the date is
  the UTC day of `publishedAt`, else `createdAt`.
- **Notes**: "GitHub: N repos in acme (K excluded), M with releases in this window." When none of the
  repos read were private: the token could see only public repos, and what access private ones need.
- **Accounting**: every call goes through the transport log (free, the token's source as credential),
  so the progress panel's request total includes them, and the GitHub line reads
  "acme: 143 repos, 37 releases; 3 requests via gh login". `--dry-run` cannot size an org, so it lists one GraphQL
  request and an estimate line.
- **Clutter**: one chart marker per day ("3 releases", up to 8 names in the tooltip); at most 30
  marked days, keeping days an anomaly points at, then the busiest. An anomaly carries `release` (the
  nearest) and `releases` (every release that day); every output names them with their repo, the
  TUI detail one per line.

### Keys

Env vars or flags. Never written, logged or output; a test asserts no key substring appears in
any output.

## The common data model

```
Row = { date, provider, kind: 'cloud'|'ai'|'commitment', service, account|null, project|null,
        usageType|null, cost, currency }
```

`SourceResult = { rows, detailRows, tagCoverage, releases, notes, basis }`.

- `rows` are summed for totals and must not double count.
- `detailRows` carry `usageType` and are used only for drill-down and candidates, never
  summed into totals. For FOCUS they are the same rows; for AWS they come from requests 2 and 3.
- `basis` is one line per source describing what its amounts mean.
- `project` is the OpenAI project or Anthropic workspace name.
- AI billed through live AWS Cost Explorer (Bedrock) stays `cloud`, because Cost Explorer does
  not say which services are AI. In a FOCUS export, rows from an AI provider or publisher, or in
  the `AI and Machine Learning` service category (which covers Bedrock, Azure OpenAI and Vertex),
  are `ai`.
- `commitment` is Savings Plans and Reserved Instance charges: AWS commitment record types and
  FOCUS `Purchase` rows. AI sources are always `ai`. Live AWS rows have `account` null.
- Credits and refunds are negative rows of their own, never netted into a usage row.
- Mixed currencies: the dominant one is used, the rest listed as excluded. No FX.
- Window end: today minus 2 days (UTC) by default, `--end` overrides.

## Analysis (adapted from Plutus's private backend)

Each adapted file names its origin path and the Plutus commit in a header comment.

- **Drivers**: last 30 days against the previous 30, per `(provider, kind, service)`, so a
  commitment never merges with usage of the same service, ranked by
  absolute change, top 10, with share of total change (logic of `cost-drivers.js`
  `rankDrivers`). Each driver lists its top 3 usage types by absolute change when detail rows
  exist for it.
- **Anomalies**: the pure core of `anomaly-detection.js`, slid over every day of the window per
  `(provider, service)`. The baseline is the mean of the last 4 same-weekday days, falling back
  to the prior 7. A spike needs to be up 50% or more and above the absolute floor: 2% of the
  trailing 8-day median daily total, clamped between $10 and $500. The median, unlike Plutus's
  mean, keeps a fee on the 1st of the month from doubling the floor for the week after it.
  Severity is set by floor multiple: 3x is medium, 10x is high. Flagged days of one series with
  at most one unflagged day between them are one episode: the 4-week baseline lags a level shift,
  so a service that runs high for a week would otherwise fill the list on its own. An episode
  reports its peak day (cost, baseline, delta, severity), its first and last day, the excess
  summed over its flagged days and the day's usage total. Ranked by peak dollar delta and capped
  at 10. Commitment rows are ignored: Reserved Instance fees post on the 1st of the month and are
  not usage. Monthly charges (above) are left out too, tax among them, so neither they nor the
  floor's median daily total can make the 1st look like a spike. Negative rows (credits and refunds) are ignored too, so days are judged on charges
  before credits: a credit booked under a service would otherwise lower that weekday's baseline
  for four weeks and make ordinary days look like spikes. Each anomaly shows the nearest release from 2 days before its first day to its peak,
  labelled as context, never as the cause.
- **Monthly charges** (`analysis/monthly.js`, new): charges billed once on the 1st for the month,
  such as tax and a monthly Reserved Instance fee, are accurate to the bill but would read as
  spikes in a daily view. A row is spread when it falls on the 1st, is positive, and either its
  source marked it monthly and it is at least half of what its series (provider, kind, service)
  billed that month, or its series bills only on the 1st in two or more months of the window (which
  also catches a Support plan fee). Sources mark, on the 1st, AWS `Tax`, the reservation fee record
  types (`RIFee`, `Recurring`, which become the `<service> reservations` row and carry no usage type)
  and `SavingsPlanRecurringFee`, and FOCUS rows that are `Tax` or whose charge period runs 28 days or
  more. The half rule spreads a Reserved Instance fee even when an instance bought mid-month adds a
  prorated fee to the same row on another day, and leaves a fee that Cost Explorer shows every day
  (a no-upfront Savings Plan) as billed. Only the charge on the 1st moves; a credit or a one-off
  purchase never does. Each charge is spread evenly over every day
  of its calendar month. For the month the window ends in, the days still to come are not drawn as
  actual spend: the forecast is fitted to the spread series and so carries that daily rate forward,
  and the month-end projection is the month so far as billed plus that forecast. Only the daily
  views (HTML, dashboard and TUI charts, the plain sparkline) and the forecast use the spread series;
  every total, the headline, drivers and tables are as billed. Anomalies leave these charges out.

  Cost Explorer's AmortizedCost would spread Reserved Instance and Savings Plan fees properly, and
  asking for it beside UnblendedCost costs no extra request. It is not used: it folds the fees into
  the usage they cover, which would empty the commitments category and change every total away from
  the bill, it does nothing for tax, and FOCUS and the AI sources have no equivalent. Spreading in the
  daily views alone works the same way for every source and leaves the totals as billed. The tag
  queries are the exception, since the untagged share is a ratio, not a total.
- **Forecast**: `forecast.js` `fitModel` and `projectPeriodTotal`, unchanged, over the daily
  total of every kind with monthly charges spread (above). Gives the month-end projection, whose
  month to date stays as billed, and a 14-day dashed extension on the daily chart. No band.
- **Candidates to review** (AWS usage types, from AWS detail rows or FOCUS `x_UsageType`; Azure and Google Cloud
  charge descriptions, from FOCUS `ChargeDescription`; see Azure and Google Cloud rules). Each
  rule matches a usage type after any region prefix and sums the last 30 days. Commitment rows
  are never candidates. Show a rule if it totals at least $10. Candidates are ordered by group, then by
  dollars (see Candidate strength). Every candidate
  over the minimum is kept in the report data; there is no cap there (46 rules cannot make more than 46),
  and each output decides how many it shows (see the dashboard and the HTML report below). Each candidate
  has a title and a one-line "why look". A rule reads a usage type name and, where a name is shared
  between services, the service; it never reads utilisation, CloudWatch or a repo, which is what keeps
  every candidate a place to look and not a finding.

  **How a rule is written.** The `why` is a short factual reason, conditional, with no promised saving and
  no percentage unless it is a published price relationship (`gp2` is the model: gp3 is listed about 20%
  below gp2 per GB-month). Every match was taken from a real usage type in the AWS Price List bulk API
  (the per-service `index.csv` offer files, which list `usageType` values and need no credentials) and
  every service gate from the `ServiceName` values of the official FOCUS 1.0 sample;
  `test/fixtures/candidates/usage-types.json` records, per rule, the offer and the real strings it was
  checked against, plus nearby real strings it must not match, and `candidates.test.js` reads it. A
  pattern that could not be found there was left out rather than guessed. Names that several services bill
  alike (`TimedStorage-ByteHrs` is S3, CloudWatch Logs and ECR storage; `DataProcessing-Bytes` is CloudWatch
  Logs ingestion and Classic Load Balancer traffic) are told apart by a service gate that matches a fragment of
  the service name without case, because Cost Explorer and FOCUS spell some services differently.

  **Candidate strength.** Every rule is `strong` or `look`, and candidates are ordered: those with
  `plutusFix` first, then `strong`, then `look`, each group by last-30-day cost, biggest first, ties in
  table order. Every output uses that order (the top-five cut and the `and N more` line are unchanged), so
  a large cost centre can no longer bury a small, likely finding. A rule is `strong` only when the billing
  line itself is evidence of something usually worth changing, in one of three ways: an idle resource
  (`idle-ip`), a superseded generation or storage class with a cheaper like-for-like successor (`gp2`,
  older EC2, RDS, ElastiCache and OpenSearch generations, Classic Load Balancer), or a surcharge that
  exists because of how something is configured (`extended-support`, `ec2-cpu-credits` for unlimited-mode
  burst, `s3-early-delete`). A rule is `look` when its line is a legitimate cost centre that is only
  sometimes waste (storage, transfer, NAT, Multi-AZ, provisioned capacity, keys, logs). The test is strict:
  when unsure a rule is `look`. Two judgement calls: `ebs-hdd` is `look` because one rule covers both
  magnetic volumes and the st1 and sc1 types that are the right choice for some workloads, which a billing
  line cannot separate; `redshift-old-gen` and `lambda-x86` are `look` because the newer choice is not a
  like-for-like swap. The groups are named in every output: "Often worth changing" for strong and "Worth a
  look" for look (a label line in the terminal and dashboard, an italic line in Markdown, a prefix on the
  why line in the HTML report), and `--json` carries `strength` on each candidate.

  **Azure and Google Cloud rules.** The same engine reads FOCUS exports from the other two clouds.
  Each rule carries a `provider` (`aws`, `azure`, `gcp`, the FOCUS `ServiceProviderName` slug), a row is tested
  only against its own provider's table, and the AWS region prefix is stripped only for `aws`. The row
  model did not change: for a FOCUS row `usageType` is `x_UsageType` else `ChargeDescription`, and neither
  Azure nor Google exports have an `x_UsageType`, so the rule reads `ChargeDescription` (the provider's own
  SKU wording) and `ServiceName`. Each candidate carries its `provider`. Rules live in
  `src/analysis/candidate-rules-focus.js`, and `test/fixtures/candidates/focus-strings.json` records, per rule,
  the strings it matches, the nearby real strings it must not, and where each was seen.

  What a FOCUS export carries was checked against real data on 2026-11-12. The official FOCUS 1.0 sample
  data (100,000 rows) has 4,964 Microsoft rows and two Google Cloud rows. Azure rows carry `ServiceName`,
  `ServiceCategory`, `ResourceType` (for example `Disk`, `Public IP address`, `Log Analytics workspace`),
  `SkuId` (a meter id) and a `ChargeDescription` that is Azure's meter name, such as `Standard HDD Managed
  Disks - S10 - LRS - Disk - US Central`. Microsoft's FOCUS cost export documentation lists more `x_`
  columns (`x_SkuMeterCategory`, `x_SkuMeterSubcategory`, `x_SkuMeterName`, `x_SkuDescription`,
  `x_ResourceType`), but none are in the sample, so no rule matches on them and no string was taken on
  trust. Google's FOCUS view documentation says `ChargeDescription` is the SKU description and `ServiceName`
  the service description; it has no `ResourceType` column. The Google strings come from Google's own
  pages (the Cloud NAT pricing page, the legacy SKU list and the billing query examples) because the
  sample has two rows only. Eleven Azure rules and eight Google Cloud rules came out of that, 19 in all. A
  signal with no string seen in real data or a Google page was left out; the ones dropped are listed in the
  fixture. Two limits are structural: a FOCUS row never says whether a disk or address is attached, so
  these rules are as bill-only as the AWS ones (the one `strong` Google rule, idle Cloud SQL addresses, is
  strong because Google names the charge `IP address idling`), and the only `strong` Azure rule is the
  older VM series (Dv2, Dv3 and Dsv4, which Microsoft's size overview no longer lists among current
  D-family series). No Azure or Google Cloud rule carries `plutusFix`.

  The rules, in table order (`ChargeDescription` is matched without case, and the region or other
  suffix after the patterns is ignored):

  | id | provider | matches `ChargeDescription` | title | why look | strength | seen in |
  |---|---|---|---|---|---|---|
  | `azure-old-vm-series` | azure | `Virtual Machines <series> Series - ` for Dv2/DSv2, Dv3/DSv3, Dsv4 | Older VM series | Previous-generation series; newer ones are available | strong | FOCUS sample data |
  | `azure-hdd-disks` | azure | starts with `Standard HDD Managed Disks - ` | Standard HDD managed disks | Disk size tiers and operations bill whether or not the disk is busy | look | FOCUS sample data |
  | `azure-premium-disks` | azure | starts with `Premium SSD Managed Disks - ` | Premium SSD managed disks | Billed by size tier, so an oversized disk costs the same as a busy one | look | FOCUS sample data |
  | `azure-page-blob-disks` | azure | `Standard Page Blob - ` or `Premium Page Blob - ` naming a disk, service `Storage Accounts` | Unmanaged page blob disks | Page blob disks are the older, unmanaged disk model | look | FOCUS sample data |
  | `azure-public-ip` | azure | `IP Addresses - Basic|Standard IPv4 Static|Dynamic Public IP`, optionally `- Dev/Test` | Public IP addresses | Each public IP address bills by the hour; check each is still in use | look | FOCUS sample data |
  | `azure-log-ingestion` | azure | `Log Analytics - Pay-as-you-go Data Ingestion`, service `Azure Monitor` | Log Analytics ingestion | Log volume, not queries, is what this line bills | look | FOCUS sample data |
  | `azure-log-retention` | azure | `Log Analytics - Pay-as-you-go Data Retention`, service `Azure Monitor` | Log Analytics retention | Logs kept past the included period keep billing by the month | look | FOCUS sample data |
  | `azure-inter-region` | azure | starts with `Bandwidth Inter-Region - ` | Inter-region data transfer | Traffic leaving one Azure region for another | look | FOCUS sample data |
  | `azure-egress` | azure | `Rtn Preference: MGN - Standard Data Transfer Out` | Internet data transfer out | Check what is sending it | look | FOCUS sample data |
  | `azure-vpn-gateway` | azure | starts with `VPN Gateway - ` | VPN gateways | A gateway bills by the hour whether or not traffic flows | look | FOCUS sample data |
  | `azure-backup` | azure | starts with `Backup - ` | Backup instances and stored data | Protected instances and stored backup data bill monthly; retention drives it | look | FOCUS sample data |
  | `gcp-sql-idle-ip` | gcp | starts with `IP address idling`, service Cloud SQL | Idle Cloud SQL IP addresses | Billed while the address is reserved but not in use | strong | Google documentation |
  | `gcp-static-ip` | gcp | `Static Ip Charge` | Static external IP addresses | A reserved address bills by the hour; check each is attached | look | Google documentation |
  | `gcp-pd-standard` | gcp | `Storage PD Capacity`, service Compute Engine | Standard persistent disks | Provisioned capacity bills whether or not the disk is busy | look | Google documentation |
  | `gcp-pd-snapshots` | gcp | `Storage PD Snapshot` | Persistent disk snapshots | Old snapshots tend to accumulate | look | Google documentation |
  | `gcp-nat` | gcp | `Networking Cloud NAT` or `Private NAT` with `IP usage`, `data processing` or `gateway uptime` | Cloud NAT | Often traffic that could use Private Google Access | look | Google documentation |
  | `gcp-n1` | gcp | `N1 Predefined Instance Core|Ram running in <region>` | N1 instances | N1 is the oldest general-purpose family; newer families are available | look | Google documentation |
  | `gcp-lb-forwarding` | gcp | starts with `Cloud Load Balancer Forwarding Rule` | Load balancer forwarding rules | Each forwarding rule bills by the hour | look | FOCUS sample data |
  | `gcp-artifact-registry` | gcp | `Artifact Registry Storage`, service Artifact Registry | Artifact Registry storage | Old and untagged images accumulate without a cleanup policy | look | FOCUS sample data |

  **Precedence.** One billing row matches at most one rule. The rules are disjoint by construction (a
  family list, an exact name or a service gate each), and a test checks that no usage type in the fixture,
  under any of the gated service names, matches two. So table order never decides which rule a row
  belongs to; it only orders candidates of equal cost. Where two rules look alike the split is explicit:
  an older RDS generation is `rds-old-gen` whether or not it is Multi-AZ, and `rds-multi-az` excludes those
  families. `extended-support` matches the EKS, RDS and OpenSearch spellings, which differ in case.

  **What a bill cannot tell apart.** Application, Network and Classic load balancer hours share one usage
  type (`LoadBalancerUsage`), so `elb-classic` rests on Classic's data processing line alone. Idle
  and unused resources, right-sizing, and anything that needs a metric are out of reach by design.

  | id | match | title | why look | strength |
  |---|---|---|---|---|
  | `idle-ip` | `ElasticIP:IdleAddress`, `PublicIPv4:IdleAddress` | Idle public IPs | Billed while attached to nothing | strong |
  | `extended-support` | contains `ExtendedSupport`, any case | Extended support charges | RDS or EKS versions past standard support | strong |
  | `nat` | `NatGateway-Hours`, `NatGateway-Bytes`, `RegionalNatGateway-Hours`, `RegionalNatGateway-Bytes` | NAT gateway | Often traffic that could use VPC endpoints | look |
  | `cross-az` | `DataTransfer-Regional-Bytes` | Cross-AZ data transfer | Traffic between availability zones | look |
  | `egress` | `DataTransfer-Out-Bytes` | Internet data transfer out | Check what is sending it | look |
  | `gp2` | `EBS:VolumeUsage.gp2` | gp2 volumes | gp3 is usually about 20% cheaper | strong |
  | `snapshots` | `EBS:SnapshotUsage` | EBS snapshots | Old snapshots tend to accumulate | look |
  | `cw-logs` | `DataProcessing-Bytes` with service `AmazonCloudWatch` | CloudWatch Logs ingestion | Log volume and retention | look |
  | `old-gen` | `BoxUsage:<family>.` where family is in m1 m2 m3 c1 c3 cc2 cr1 g2 hi1 hs1 i2 r3 t1 m4 c4 r4 t2 | Older instance generations | Newer generations cost less for the same work | strong |
  | `ec2-dedicated` | `DedicatedUsage`, `DedicatedUsage:<type>` | Dedicated Instances | Single-tenant hardware costs more per hour than shared | look |
  | `ec2-cpu-credits` | `CPUCredits:t<n>` (EC2; the RDS `CPUCredits:db.` form is not matched) | Burstable CPU credit charges | Billed when unlimited-mode T instances run above baseline | strong |
  | `ebs-piops` | `EBS:VolumeUsage.piops`, `.io2`, `EBS:VolumeP-IOPS.piops`, `.io2`, `.io2.tier<n>` | Provisioned IOPS volumes | Provisioned IOPS are billed whether or not they are used | look |
  | `ebs-hdd` | `EBS:VolumeUsage` (magnetic), `EBS:VolumeIOUsage`, `EBS:VolumeUsage.st1`, `.sc1` | HDD and magnetic volumes | Older volume types; check each still suits its workload | look |
  | `ebs-fsr` | `EBS:FastSnapshotRestore` | Fast snapshot restore | Billed per snapshot and zone for as long as it stays enabled | look |
  | `public-ipv4` | `PublicIPv4:InUseAddress` | Public IPv4 addresses in use | Each in-use public IPv4 address is billed by the hour | look |
  | `inter-region` | ends in `AWS-Out-Bytes`, as billed | Inter-region data transfer | Traffic leaving one region for another, replication included | look |
  | `elb-classic` | `DataProcessing-Bytes` with service `Elastic Load Balancing` | Classic Load Balancer traffic | Classic is the previous generation of load balancer | strong |
  | `rds-old-gen` | `InstanceUsage:db.<family>.` or `Multi-AZUsage:db.<family>.`, family in m1 m2 m3 m4 r3 r4 t1 t2 | Older RDS instance generations | Newer generations cost less for the same work | strong |
  | `rds-multi-az` | `Multi-AZUsage:db.` of a family not in the row above | RDS Multi-AZ instances | A standby in a second zone is billed too; worth it where uptime matters | look |
  | `rds-piops` | `RDS:PIOPS`, `RDS:PIOPS-Storage`, `RDS:IO2-PIOPS`, `RDS:PIOPS-Storage-IO2`, each also as `RDS:Multi-AZ-...` | RDS provisioned IOPS | Provisioned IOPS are billed whether or not they are used | look |
  | `rds-backup` | `RDS:ChargedBackupUsage`, `Aurora:BackupUsage` | RDS and Aurora backup storage | Billed beyond the free allowance; retention and old snapshots drive it | look |
  | `rds-gp2` | `RDS:GP2-Storage`, `RDS:Multi-AZ-GP2-Storage` | RDS gp2 storage | gp3 storage is available for RDS | look |
  | `aurora-io` | `Aurora:StorageIOUsage` | Aurora I/O requests | I/O-Optimized has no per-request charge; compare it for I/O-heavy clusters | look |
  | `s3-standard` | `TimedStorage-ByteHrs` with service `Amazon Simple Storage Service` | S3 Standard storage | Data that is rarely read can sit in a cheaper class | look |
  | `s3-requests` | `Requests-Tier1`, `Requests-Tier2` with service `Amazon Simple Storage Service` | S3 requests | Request volume, not storage, can be what drives the bill | look |
  | `s3-early-delete` | starts with `EarlyDelete-` | S3 early-delete fees | Objects removed before their storage class minimum period | strong |
  | `cw-metrics` | `CW:MetricMonitorUsage`, `CW:AlarmMonitorUsage`, `CW:HighResAlarmMonitorUsage`, `CW:CompositeAlarmMonitorUsage` | CloudWatch metrics and alarms | Each custom metric and alarm bills monthly, so they add up | look |
  | `cw-logs-storage` | `TimedStorage-ByteHrs` with a CloudWatch service | CloudWatch Logs storage | Retention keeps stored logs billing; ingestion is a separate line | look |
  | `cw-api` | `CW:GMD-Metrics`, `CW:Requests` | CloudWatch API requests | GetMetricData and other calls, often from dashboards or exporters | look |
  | `lambda-provisioned` | `Lambda-Provisioned-Concurrency`, `Lambda-Provisioned-GB-Second`, each with or without `-ARM` | Lambda provisioned concurrency | Billed while configured, whether or not it is invoked | look |
  | `lambda-x86` | `Lambda-GB-Second` | Lambda duration on x86 | Arm duration is priced lower per GB-second | look |
  | `ddb-provisioned` | `ReadCapacityUnit-Hrs`, `WriteCapacityUnit-Hrs`, optionally with `IA-` | DynamoDB provisioned capacity | Billed by the hour whether or not it is used; on-demand is the alternative | look |
  | `ddb-backups` | `TimedBackupStorage-ByteHrs`, `TimedPITRStorage-ByteHrs` | DynamoDB backups and point-in-time recovery | Retention and old on-demand backups keep billing | look |
  | `elasticache-old-gen` | `NodeUsage:cache.<family>.` for m4 r4 t2 | Older ElastiCache node types | Newer node types cost less for the same work | strong |
  | `opensearch-old-gen` | `ESInstance:<family>.` for c4 i2 m3 m4 r3 r4 t2 | Older OpenSearch instance types | Newer instance types cost less for the same work | strong |
  | `redshift-old-gen` | `Node:dc2.` | Older Redshift node types | RA3 is the current node generation | look |
  | `vpc-endpoints` | `VpcEndpoint-Hours`, `VpcEndpoint-Bytes` | VPC interface endpoints | Billed per endpoint, zone and hour, plus data processed | look |
  | `tgw` | `TransitGateway-Hours`, `TransitGateway-Bytes` | Transit Gateway | Attachment hours and data processing bill on top of the traffic | look |
  | `eks-clusters` | `AmazonEKS-Hours:perCluster` | EKS cluster hours | Every cluster bills a control plane by the hour | look |
  | `ecr-storage` | `TimedStorage-ByteHrs` with service `Amazon EC2 Container Registry (ECR)` | ECR image storage | Old and untagged images accumulate without a lifecycle policy | look |
  | `kms` | ends in `KMS-Keys` or `KMS-Requests`, as billed | KMS keys and requests | Each customer managed key bills monthly, and every request bills | look |
  | `secrets` | `AWSSecretsManager-Secrets` | Secrets Manager secrets | Each secret bills monthly, used or not | look |
  | `cloudtrail-events` | `PaidEventsRecorded`, `DataEventsRecorded` | CloudTrail paid and data events | Extra trails and data event logging bill per event | look |
  | `config` | `ConfigurationItemRecorded`, `ConfigurationItemRecordedDaily`, `ConfigRuleEvaluations`, `ConformancePackEvaluations` | AWS Config recording and rules | Billed per configuration item and per rule evaluation | look |
  | `kinesis-shards` | `Storage-ShardHour`, `Extended-ShardHour` | Kinesis provisioned shard hours | Billed per shard-hour whether or not data flows | look |
  | `sagemaker-hours` | `Host:ml.<type>`, `Notebk:ml.<type>` | SageMaker endpoint and notebook hours | Billed for every hour the instance is up, used or not | look |

  **Pull-request pointer.** A rule may carry `plutusFix: 'pull_request'`, meaning Plutus can open a
  pull request that fixes this kind of waste. Today that is `gp2` alone (changing volumes
  to gp3, an attribute change); no other rule carries it, and no other candidate says anything about
  pull requests. `idle-ip` carried it in an earlier commit by mistake: the fix is to remove an Elastic
  IP, a removal rather than an attribute change, which Plutus cannot open a pull request for yet. The field lives only in the rule table, is copied onto each
  candidate (`null` when the rule has none) and every output reads it from there. The wording stays
  conditional, because a candidate is a place to look and not proven waste: "If this is waste, Plutus
  can open the pull request that fixes it." (compact form for a narrow cell: "Plutus can open the fix
  as a pull request"). It states no price, plan or number of free pull requests, and plutus-scan itself
  recommends no code change and never looks in a repo. In HTML and Markdown the sentence is a plain
  link to `https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=<report|md>&utm_content=<candidate id>`.
  The URL holds only the surface and the fixed rule id, never a figure, account or usage type, and
  `plutus-fix.test.js` asserts that for every rule. A link is a navigation the reader chooses to
  follow; plutus-scan makes no request to plutus-cloud.com.

- **Untagged**: per active AWS tag key (live) or top 5 FOCUS tag keys by tagged spend, last 30
  days, cloud only, label `Untagged`.
- **AI projects**: AI spend per `(provider, project)` over the window with share of AI total.

Short history: each section states what it needs (anomalies 8 days, drivers 60, forecast 14)
and says "not enough history (n days)" instead of a misleading chart.

## Headline (first in every output)

- Last 30 days total, split into cloud, commitments (when there are any) and AI.
- Change against the previous 30 days, in dollars and percent.
- Top 3 movers, each with its leading usage type.
- The largest anomaly in dollars.
- The month-end projection.
- One copyable sentence, exactly in this shape:

```
Last 30 days: $12,340 ($9,870 cloud, $2,470 AI), +18% vs the previous 30. Biggest mover: AWS EC2-Other / NatGateway-Bytes +$1,610. Projected October total: $13,100.
```

With commitment spend in the last 30 days, the split names it between cloud and AI:
`($9,870 cloud, $3,200 commitments, $2,470 AI)`. Without it the shape above is unchanged. The
headline blocks in the terminal, HTML and TUI show the commitment total the same way.

Clauses whose data is missing are dropped. With no prior period, the sentence says "no previous
30 days to compare".

## Basis and freshness (every output)

One line per source, stating what its amounts include:

- AWS: "UnblendedCost from Cost Explorer, including credits, refunds and tax as billed."
- FOCUS: "BilledCost, including credit and tax rows when present."
- OpenAI: "as reported by the organization costs API."
- Anthropic: "as reported by the cost report API; Priority Tier not included."

Then: "Last complete day: <end>. Currency: <CUR>."

## Outputs

### Progress while sources are read

When stdout and stderr are both terminals, `CI` is unset and neither `--json`, `--md` nor `--tui` is
passed, the run is drawn as a live panel on stderr (`src/ui/progress.js`, with the dashboard's theme and
panel). Under the dashboard's top line, a panel names the sources in its edge and holds one line per
source: waiting, then a spinner with the current step (for AWS: checking the aws CLI, fetching daily
spend, fetching usage types, finding candidates, reading tag coverage), then a tick with days, services
or projects, requests and cost, a cross with the short reason, or a dash with why it was skipped. Below
them are the analysis steps (drivers, anomalies, forecast, candidates), ticked when the report is
built, and the request count, the billed Cost Explorer cost and the elapsed time.

It redraws in place about ten times a second, moving the cursor up over the last frame, with every line
cut to the terminal width so it never wraps. The cursor is hidden while it runs and always restored: at
the end, after an error, on Ctrl-C or SIGTERM (which print "Stopped." and exit 130 or 143) and on any
exit. At the end the panel is erased and replaced by one line, such as "✓ Scanned AWS Cost Explorer,
OpenAI · 21 requests · 19 billed, $0.19 · 4.2s", or "✗ No source could be read" followed by the notes,
since no report follows to carry them. On a run that writes an HTML report, "Wrote report: <path>"
(with ", opening in your browser" when it opens) comes before the real-spend warning, which is
unchanged. `--demo` pauses about a third of a second per step, only on the live panel, so the run can
be watched. Every other run writes the plain progress lines ("Checking the aws CLI...") as before.

### Terminal (default)

On a terminal the summary is drawn as a dashboard; otherwise (piped, redirected, CI) it is a plain
summary. The stdout the run was given decides, not the process's own. Both are built from the same
report data, and the dashboard's sections are shared with the TUI (`src/report/dashboard.js`,
drawing blocks in `src/ui/widgets.js`).

The dashboard, in order:

1. A title line with the window and currency, then the headline sentence.
2. Tiles: last 30 days (with a small chart), change against the previous 30, the month-end
   forecast, and commitments when there are any.
3. Daily spend as a bar chart stacked by cloud, commitments and AI, with the forecast and a mark
   under each anomaly day.
4. Top movers beside the largest anomaly.
5. Top drivers (8, or 5 when compact) with their usage types, share bars and a 60-day trend.
6. Anomalies (top 5).
7. Candidates (top 5, in the order set under Candidate strength). A muted label line (`Often worth changing`,
   `Worth a look`) opens each group. A candidate with a pull-request pointer gets one more muted line under it,
   indented, in the compact wording. When any shown candidate has a pointer, the section ends with one
   muted line, the bare URL `https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=cli` (63
   columns, no candidate id, no OSC 8), indented like the section. When there are more than five
   candidates the section ends with one more muted line, `and N more, listed in --json and the HTML
   report`, which truncates like every other line. There is no limit larger than five: with 46 rules
   the list is still the five biggest, and the rest are one flag away.
8. AI by project (top 5).
9. Notes and basis, then the AWS request line.

The plain summary has the same content as headings and aligned lines: the headline, a daily
block-character sparkline, top 5 drivers with their usage types, anomalies (top 3), candidates
(top 5, each with its why line and, for a candidate with a pull-request pointer, the full sentence as one
more indented line), then, once at the end of the section and only when a shown candidate has a pointer,
the same bare `utm_medium=cli` URL as one indented line, then, when there are more than five, the one
indented line `and N more, listed in --json and the HTML report` (the same line in the dashboard and in the
Markdown list), AI by project (top 5), notes and basis, and the AWS request line.

Layout rules:

- Colour only when stdout is a TTY, `NO_COLOR` is unset and `--no-color` isn't passed. The
  dashboard then uses the Plutus palette at 24-bit, 256 or 16 colours, picked from `COLORTERM`
  and `TERM`.
- Compact layout below 100 columns; every dashboard line fits at 80, and it stops widening at 160.
- `--braille` switches the sparklines to braille.
- No colour dependency.

On a bare interactive run the terminal summary is followed by the HTML report; see below.

### `--md <file|->`

The same content as GitHub-flavoured Markdown, sized for a pull request or issue: the headline sentence, a
drivers table, the top anomalies and the top five candidates (then the `and N more` line the terminal
uses), and the basis. A candidate with a pull-request
pointer ends its line with the sentence as a link (`utm_medium=md`). The footer line appears once.

### Default HTML report

A bare run is one with none of `--html`, `--md`, `--json`, `--tui` or `--dry-run`, on a stdout that is a TTY,
with `CI` unset. After the terminal summary it writes the HTML report below to
`<os temp dir>/plutus-scan/report-<window end YYYY-MM-DD>.html`, creating the folder and overwriting only
within it, prints the warning line, and opens the file with the platform opener. The temp folder keeps real
spend figures out of any code repo. The folder is created owner-only (0700) and the file is written 0600; a folder that is a link, is owned by someone else or is open to group or others is refused. If opening fails, or Linux has no `DISPLAY` or `WAYLAND_DISPLAY`, the
printed path is all that is left; neither is an error. Nothing is written when every source failed, when any
flag above is passed (behaviour is then exactly as for that flag), or when stdout is not a TTY or `CI` is
set. `--no-html` skips the report; `--no-open` writes it without opening it. With `--demo` the file is
`demo-report-<window end>.html`, so it never replaces a real report, the printed line says it holds
synthetic demo data instead of the real-figures warning, and the page shows a banner saying the
figures are synthetic.

### `--html <file> [--open]`

Chooses the path instead of the temp folder. One file. Data embedded as escaped JSON. The daily chart is
stacked bars drawn as inline SVG by the page's own script, with no chart library. System fonts only. This CSP
meta tag, exactly:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
```

Order:

1. **Headline block**, with a copy button for the sentence.
2. **Daily spend** as stacked bars of cloud, commitments and AI (in that order from the bottom),
   then monthly charges spread over their month as a hatched segment ("Monthly charges, spread"),
   with a mark above every flagged anomaly day, release markers and the forecast as outlined
   bars. A "Spread monthly charges" / "As billed" switch above the chart, shown only when there
   are monthly charges, redraws it with them on their day; the spread view is the default. When
   one bar is more than 2.5 times the 90th-percentile day (a genuine outlier, or a fee on the 1st
   as billed), the axis stops at 1.6 times that day and taller bars are cut and labelled, so
   ordinary days and their anomalies stay readable. This is the README screenshot.
3. **Drivers**, a table whose rows open to their usage types (see the sub-table below).
4. **Anomalies**, a table of the top 10 episodes by peak dollars: expected against actual on the
   peak day, the change as a share of that day's spend, a sparkline of the service with the
   flagged days marked, severity and the nearest release. A row shows its day on the chart.
5. **Candidates to review**, with the "not proven savings" wording in the section intro. Every
   candidate is listed, not a top few: the rows are collapsed, so a long list stays scannable. Each row
   opens to its usage types in the same sub-table as the drivers. A candidate with a pull-request
   pointer shows the compact wording as a link under its figure in the row, and the full sentence as a
   link above the sub-table once the row is open (`utm_medium=report`, a plain `<a rel="noopener">`,
   styled like the footer link, so the CSP is unchanged and the page still cannot fetch anything).

   The usage type sub-table: a candidate or driver row is a disclosure, collapsed by default. The
   whole row is clickable and its first cell is a button with `aria-expanded`, so Enter and Space
   work. Opening animates the row's height (180 ms, none with reduced motion) so nothing below
   jumps. The sub-table, indented inside the card, has Usage type, Region (read from a known prefix
   such as `USE1` or `EUW2`, else blank, and then left off the name), Last 30 days, Previous 30 and
   Change when the data has them (drivers), and Share of the parent row, sorted by cost. Past eight
   rows the rest sit behind an "N more, $X" row. On a narrow screen it scrolls sideways inside its
   card, never the page. Printing opens every sub-table with every row.
6. **AI by project**.
7. **Untagged share**, cloud only.
8. **Basis and notes**.
9. **Footer**.

Look: the Plutus app's tokens and widgets. Series colours are the app's chart palette (cloud
series 1 blue, commitments series 2 rust, AI series 4 violet), anomaly marks use the brand
marker, KPI tiles keep the figure neutral with a cost-semantic delta chip, and every list longer
than a few items is a table with tabular, right-aligned figures. Light and dark follow
`prefers-color-scheme` with a toggle. Print CSS: light theme, no toggle or copy button, sections don't split across pages.

Footer, one line only: "This is a snapshot. Plutus tracks it daily, per team and per customer,
with alerts." linking to `https://plutus-cloud.com/?utm_source=plutus-scan&utm_medium=report`.

After writing, print: "Warning: <path> contains real spend figures. Share it only with people
who should see them." `--open` uses the platform opener.

### `--json <file|->`

The full report data with `schemaVersion: 1`, tool version, window, sources and row counts.
`daily` entries are `{ date, cloud, commitment, ai, monthly, spread }`, as billed by kind, with
`monthly` the part of the day that is monthly charges billed on it and `spread` the day's share of
them once spread, both by kind. `totals` and `headline.last30` carry `commitment` beside `cloud` and
`ai`.
Each candidate carries `strength`, `'strong'` or `'look'`, and `plutusFix`, `'pull_request'` or `null`. Both are additive fields, so
`schemaVersion` stays 1; this document sets no rule that additive fields bump it.
Shaped for a future `--upload`.

### `--tui`

A full-screen, keyboard-only view of the same report data, with no new dependency. It is
hand-rolled on `node:readline` raw mode and the alternate screen buffer. It refuses to start
when stdout isn't a TTY or the terminal is smaller than 80×24.

Three views:

- **Overview**: the dashboard's tiles, the headline, the daily spend chart, the totals (with
  commitments when there are any) and the top movers.
- **Drivers**: a table with share bars and trends; pick a driver and a 60-day bar chart of it is
  shown below, and Enter shows its usage types.
- **Anomalies**: pick one and Enter shows a bar chart of the days around it.

Keys:

- `1` `2` `3`, Tab and Shift+Tab, or `←` `→` switch views, wrapping at both ends. They work from a
  detail view too: Esc and Backspace are the only keys that go back, and each view keeps its own
  detail open.
- `↑` `↓` or `j` `k` move.
- Enter drills in.
- Esc or Backspace goes back.
- `h` writes the HTML report.
- `q` quits.

Key hints stay visible. No mouse. Honours `NO_COLOR`. The terminal is always restored on exit,
including on Ctrl-C and on errors.

## Trust features

- No telemetry, no update check. A test records every HTTP host and `aws` command and asserts
  only configured providers appear.
- `--dry-run` lists every request (host and path, or the exact `aws` command), which credential
  (env var or flag name, or "gh login"; never a value) and the estimated AWS cost, and makes none
  of them.
- One runtime dependency, lockfile committed.
- The README leads with: runs locally, nothing leaves your machine, here is exactly what it
  calls. That is followed by the CSP line and how to check it, the `aws` CLI note, the IAM
  policy and the Cost Explorer pricing.
