// Adapted from Plutus's private backend (commit 8f3e0d23): plutus-backend/lib/sync/focus-rows.js
// (parseTags, truncateToUtcDay, str, NULL_SENTINELS) and lib/sync/focus.js (FocusInputError).
// Zone-less timestamps are read as UTC here (a change from the origin).
// Maps a FOCUS record to the common Row model.

import { currencyCode } from '../../model.js';

/** @typedef {import('../../model.js').Row} Row */

/** A problem with the contents of a FOCUS export, such as a missing required column. */
export class FocusInputError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FocusInputError';
  }
}

// Flat CSV exporters write a literal where a value is absent.
const NULL_SENTINELS = new Set(['null', 'n/a']);

/** @param {unknown} value @returns {string} */
function focusStr(value) {
  if (value === null || value === undefined) return '';
  const trimmed = String(value).trim();
  return NULL_SENTINELS.has(trimmed.toLowerCase()) ? '' : trimmed;
}

/** @param {unknown} raw @returns {Record<string,string>|undefined} */
function parseTags(raw) {
  if (!raw) return undefined;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.keys(raw).length > 0 ? /** @type {any} */ (raw) : undefined;
  }
  try {
    const parsed = JSON.parse(/** @type {string} */ (raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // a malformed Tags cell is treated like a missing one
  }
  return undefined;
}

/**
 * A timestamp with a time but no zone is read as UTC, never local time (FOCUS mandates UTC).
 * @param {string} isoString @returns {string|null} YYYY-MM-DD in UTC
 */
function truncateToUtcDay(isoString) {
  let s = isoString;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
  if (m) s = `${m[1]}T${m[2]}Z`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * @param {string} name
 * @returns {string} aws, azure, gcp or oci when recognised, otherwise a lowercase slug
 */
export function providerSlug(name) {
  const n = focusStr(name).toLowerCase();
  if (/^(aws|amazon)\b/.test(n)) return 'aws';
  if (/^(azure|microsoft)\b/.test(n)) return 'azure';
  if (/^(gcp|google)\b/.test(n)) return 'gcp';
  if (/^(oci|oracle)\b/.test(n)) return 'oci';
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** AI providers, as provider slugs; a cloud marketplace resale names them as the publisher. */
const AI_PROVIDERS = new Set(['openai', 'anthropic', 'mistral-ai', 'mistral', 'cohere', 'ai21-labs', 'xai', 'perplexity']);
const AI_CATEGORY = 'ai and machine learning';

/**
 * Whether a record is AI spend: an AI provider or publisher, or the FOCUS AI and Machine Learning
 * service category (which also covers a cloud's own AI services, such as Bedrock or Azure OpenAI).
 * @param {Record<string,string>} record @param {string} provider its provider slug @returns {boolean}
 */
function isAiRecord(record, provider) {
  return AI_PROVIDERS.has(provider)
    || AI_PROVIDERS.has(providerSlug(focusStr(record.PublisherName)))
    || focusStr(record.ServiceCategory).toLowerCase() === AI_CATEGORY;
}

/**
 * @param {Record<string,string>} record
 * @returns {Record<string,string>} the parsed Tags column, empty when absent
 */
export function recordTags(record) {
  return parseTags(focusStr(record.Tags)) ?? {};
}

/**
 * @param {Record<string,string>} record
 * @returns {Row|null} null when the cost is not finite or the date is missing
 */
export function focusRecordToRow(record) {
  const rawCost = focusStr(record.BilledCost);
  const cost = rawCost === '' ? NaN : Number(rawCost);
  if (!Number.isFinite(cost)) return null;
  const date = truncateToUtcDay(focusStr(record.ChargePeriodStart));
  if (!date) return null;
  // A charge on the 1st that is tax, or whose charge period runs a month or more, is billed for the month.
  const periodDays = (Date.parse(focusStr(record.ChargePeriodEnd)) - Date.parse(focusStr(record.ChargePeriodStart))) / 86400000;
  const category = focusStr(record.ChargeCategory).toLowerCase();
  const monthly = date.endsWith('-01') && (category === 'tax' || periodDays >= 28);
  // FOCUS 1.0 charge categories: Usage, Purchase, Tax, Credit, Adjustment. Purchase is commitment
  // spend; its label keeps it apart from usage of the same service. Other AI spend is reported the
  // way the OpenAI and Anthropic sources report it: by project (the sub-account), outside tag coverage.
  const purchase = category === 'purchase';
  const service = focusStr(record.ServiceName) || 'Unknown';
  const provider = providerSlug(focusStr(record.ServiceProviderName) || focusStr(record.ProviderName));
  const ai = !purchase && isAiRecord(record, provider);
  const subAccount = focusStr(record.SubAccountName) || focusStr(record.SubAccountId) || null;
  return {
    date,
    provider,
    kind: purchase ? 'commitment' : ai ? 'ai' : 'cloud',
    service: purchase ? `${service} purchases` : service,
    account: ai ? null : subAccount,
    project: ai ? subAccount : null,
    usageType: focusStr(record.x_UsageType) || focusStr(record.ChargeDescription) || null,
    cost,
    currency: currencyCode(focusStr(record.BillingCurrency)),
    ...(monthly ? { monthly: /** @type {true} */ (true) } : {}),
  };
}
