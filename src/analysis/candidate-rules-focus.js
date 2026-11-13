/**
 * Candidate rules for Azure and Google Cloud, read from FOCUS exports. A FOCUS row has no AWS usage type:
 * the row model's `usageType` is the row's `ChargeDescription` (the provider's own words for the SKU) and
 * `service` its `ServiceName`, so these rules match those two, not a usage type. No region prefix is
 * stripped; both providers put the region at the end of a description or not at all, and the patterns
 * stop before it.
 *
 * Every pattern is anchored on a string seen in real data, recorded in
 * test/fixtures/candidates/focus-strings.json with where it was seen:
 *  - Azure: ChargeDescription values of the official FOCUS 1.0 sample data (its 100,000-row file has 4,964
 *    Microsoft rows), which is real Azure Cost Management output.
 *  - Google Cloud: the sample data has two Google Cloud rows only, so the rest are SKU descriptions printed
 *    in Google's own documentation (the Cloud NAT pricing page, the Cloud Billing legacy SKU list and the
 *    Cloud Billing query examples). Google's FOCUS view fills ChargeDescription from the SKU description.
 * A signal with no string found in either was left out rather than guessed. Rules follow the same
 * conventions as candidates.js: disjoint, bill-only, `strength` strict (when unsure, `look`), and no
 * `plutusFix` (Plutus fixes no Azure or Google Cloud waste yet).
 *
 * @typedef {import('./candidates.js').CandidateRule} CandidateRule
 */

/** @param {RegExp} re @returns {(service: string) => boolean} */
const inService = (re) => (service) => re.test(service);
const isMonitor = inService(/^azure monitor$/i);
const isCloudSql = inService(/cloud sql/i);
const isCompute = inService(/compute engine/i);
const isArtifactRegistry = inService(/^artifact registry$/i);

/** @type {CandidateRule[]} */
export const AZURE_CANDIDATE_RULES = [
  {
    id: 'azure-old-vm-series', provider: 'azure', strength: 'strong', title: 'Older VM series',
    why: 'Previous-generation series; newer ones are available',
    // Series that Microsoft's size overview no longer lists among the current D-family series.
    test: (u) => /^Virtual Machines (?:Dv2\/DSv2|Dv3\/DSv3|Dsv4) Series - /i.test(u),
  },
  {
    id: 'azure-hdd-disks', provider: 'azure', strength: 'look', title: 'Standard HDD managed disks',
    why: 'Disk size tiers and operations bill whether or not the disk is busy',
    test: (u) => /^Standard HDD Managed Disks - /i.test(u),
  },
  {
    id: 'azure-premium-disks', provider: 'azure', strength: 'look', title: 'Premium SSD managed disks',
    why: 'Billed by size tier, so an oversized disk costs the same as a busy one',
    test: (u) => /^Premium SSD Managed Disks - /i.test(u),
  },
  {
    id: 'azure-page-blob-disks', provider: 'azure', strength: 'look', title: 'Unmanaged page blob disks',
    why: 'Page blob disks are the older, unmanaged disk model',
    test: (u, service) => /^(?:Standard|Premium) Page Blob - .*\bDisk\b/i.test(u) && /storage accounts/i.test(service),
  },
  {
    id: 'azure-public-ip', provider: 'azure', strength: 'look', title: 'Public IP addresses',
    why: 'Each public IP address bills by the hour; check each is still in use',
    test: (u) => /^IP Addresses - (?:Basic|Standard) IPv4 (?:Static|Dynamic) Public IP(?: - |$)/i.test(u),
  },
  {
    id: 'azure-log-ingestion', provider: 'azure', strength: 'look', title: 'Log Analytics ingestion',
    why: 'Log volume, not queries, is what this line bills',
    test: (u, service) => /^Log Analytics - Pay-as-you-go Data Ingestion(?: - |$)/i.test(u) && isMonitor(service),
  },
  {
    id: 'azure-log-retention', provider: 'azure', strength: 'look', title: 'Log Analytics retention',
    why: 'Logs kept past the included period keep billing by the month',
    test: (u, service) => /^Log Analytics - Pay-as-you-go Data Retention(?: - |$)/i.test(u) && isMonitor(service),
  },
  {
    id: 'azure-inter-region', provider: 'azure', strength: 'look', title: 'Inter-region data transfer',
    why: 'Traffic leaving one Azure region for another',
    test: (u) => /^Bandwidth Inter-Region - /i.test(u),
  },
  {
    id: 'azure-egress', provider: 'azure', strength: 'look', title: 'Internet data transfer out',
    why: 'Check what is sending it',
    test: (u) => /^Rtn Preference: MGN - Standard Data Transfer Out(?: - |$)/i.test(u),
  },
  {
    id: 'azure-vpn-gateway', provider: 'azure', strength: 'look', title: 'VPN gateways',
    why: 'A gateway bills by the hour whether or not traffic flows',
    test: (u) => /^VPN Gateway - /i.test(u),
  },
  {
    id: 'azure-backup', provider: 'azure', strength: 'look', title: 'Backup instances and stored data',
    why: 'Protected instances and stored backup data bill monthly; retention drives it',
    test: (u) => /^Backup - /i.test(u),
  },
];

/** @type {CandidateRule[]} */
export const GCP_CANDIDATE_RULES = [
  {
    id: 'gcp-sql-idle-ip', provider: 'gcp', strength: 'strong', title: 'Idle Cloud SQL IP addresses',
    why: 'Billed while the address is reserved but not in use',
    test: (u, service) => /^IP address idling\b/i.test(u) && isCloudSql(service),
  },
  {
    id: 'gcp-static-ip', provider: 'gcp', strength: 'look', title: 'Static external IP addresses',
    why: 'A reserved address bills by the hour; check each is attached',
    test: (u) => /^Static Ip Charge$/i.test(u),
  },
  {
    id: 'gcp-pd-standard', provider: 'gcp', strength: 'look', title: 'Standard persistent disks',
    why: 'Provisioned capacity bills whether or not the disk is busy',
    test: (u, service) => /^Storage PD Capacity$/i.test(u) && isCompute(service),
  },
  {
    id: 'gcp-pd-snapshots', provider: 'gcp', strength: 'look', title: 'Persistent disk snapshots',
    why: 'Old snapshots tend to accumulate',
    test: (u) => /^Storage PD Snapshot$/i.test(u),
  },
  {
    id: 'gcp-nat', provider: 'gcp', strength: 'look', title: 'Cloud NAT',
    why: 'Often traffic that could use Private Google Access',
    test: (u) => /^Networking (?:Cloud|Private) NAT (?:IP usage|data processing|gateway uptime)$/i.test(u),
  },
  {
    id: 'gcp-n1', provider: 'gcp', strength: 'look', title: 'N1 instances',
    why: 'N1 is the oldest general-purpose family; newer families are available',
    test: (u) => /^N1 Predefined Instance (?:Core|Ram) running in /i.test(u),
  },
  {
    id: 'gcp-lb-forwarding', provider: 'gcp', strength: 'look', title: 'Load balancer forwarding rules',
    why: 'Each forwarding rule bills by the hour',
    test: (u) => /^Cloud Load Balancer Forwarding Rule\b/i.test(u),
  },
  {
    id: 'gcp-artifact-registry', provider: 'gcp', strength: 'look', title: 'Artifact Registry storage',
    why: 'Old and untagged images accumulate without a cleanup policy',
    test: (u, service) => /^Artifact Registry Storage$/i.test(u) && isArtifactRegistry(service),
  },
];
