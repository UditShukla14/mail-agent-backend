// Connection to the AI apps hub (the agent backend). It owns subscriptions, wallets and the usage ledger of every AI app;
// Raven (the mail agent) asks it whether a company may use Raven and reports what each model call used.
//
//   AGENT_HUB_URL     base URL of the agent backend, e.g. https://mcp.worxstream.ai
//   APP_SERVICE_KEY   shared secret, the same value as in the agent backend
//   RAVEN_BILLING=off explicitly turns the check off (local development only): Raven then runs for everyone, unmetered
//
// If the hub is NOT configured and billing is not explicitly off, Raven does not run: free, unmetered use must never happen by accident.
export const hubConfig = () => ({
  baseUrl: (process.env.AGENT_HUB_URL || '').trim().replace(/\/+$/, ''),
  serviceKey: (process.env.APP_SERVICE_KEY || '').trim(),
});

/** The hub is configured and Raven is checked and metered. */
export const hubEnabled = () => {
  const { baseUrl, serviceKey } = hubConfig();
  return Boolean(baseUrl && serviceKey);
};

/** Billing was switched off on purpose (RAVEN_BILLING=off). */
export const billingExplicitlyOff = () => String(process.env.RAVEN_BILLING || '').trim().toLowerCase() === 'off';
