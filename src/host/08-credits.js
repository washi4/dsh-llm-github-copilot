//#region credits
const unavailableCredits = (details = {}) => ({
  state: "unavailable",
  ...details.plan === void 0 ? {} : { plan: details.plan },
  ...details.quotaResetDate === void 0 ? {} : { quotaResetDate: details.quotaResetDate }
});

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

function optionalDate(value) {
  return optionalString(value) !== void 0 && Number.isFinite(Date.parse(value)) ? value : void 0;
}

/**
 * Normalize GitHub's unstable account entitlement response into the small
 * browser-facing Credits contract. Unknown fields and malformed fields are
 * ignored independently; an absent usable percentage is not treated as zero.
 */
function normalizeCredits(body) {
  const quota = body?.quota_snapshots?.premium_interactions;
  const plan = optionalString(body?.copilot_plan);
  const quotaResetDate = optionalDate(body?.quota_reset_date);
  const details = {
    ...plan === void 0 ? {} : { plan },
    ...quotaResetDate === void 0 ? {} : { quotaResetDate }
  };
  if (quota === null || typeof quota !== "object" || Array.isArray(quota)) return unavailableCredits(details);

  if (quota.unlimited === true) {
    return {
      state: "unlimited",
      ...quotaResetDate === void 0 ? {} : { quotaResetDate },
      ...plan === void 0 ? {} : { plan }
    };
  }

  const percentRemaining = finiteNumber(quota.percent_remaining);
  if (percentRemaining === void 0) return unavailableCredits(details);
  const remaining = nonNegativeInteger(quota.remaining);
  const entitlement = nonNegativeInteger(quota.entitlement);
  const clamped = Math.min(100, Math.max(0, percentRemaining));
  return {
    state: "available",
    usedPercent: 100 - clamped,
    ...remaining === void 0 ? {} : { remaining },
    ...entitlement === void 0 ? {} : { entitlement },
    ...quotaResetDate === void 0 ? {} : { quotaResetDate },
    ...plan === void 0 ? {} : { plan }
  };
}

/**
 * Fetch and normalize account Credits with the long-lived OAuth credential.
 * The caller owns failure handling so this boundary never turns an optional
 * entitlement outage into an authentication or model-discovery outage.
 */
async function fetchCredits(rawToken) {
  const response = await copilotFetch(CREDITS_URL, {
    method: "GET",
    signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    headers: {
      authorization: `token ${rawToken}`,
      accept: "application/json",
      "copilot-integration-id": INTEGRATION_ID,
      "editor-version": EDITOR_VERSION,
      "editor-plugin-version": EDITOR_PLUGIN_VERSION,
      "user-agent": EXCHANGE_USER_AGENT
    }
  });
  if (!response.ok) throw new Error(`GitHub Copilot Credits answered HTTP ${response.status}`);
  return normalizeCredits(await response.json());
}
//#endregion
