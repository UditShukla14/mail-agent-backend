// Connection to the AI apps hub (the agent backend). It owns subscriptions, wallets and the usage ledger of every AI app;
// Raven (the mail agent) asks it whether a company may use Raven and reports what each model call used.
// Both unset = billing is off and Raven runs ungated (local development).
export const hubConfig = () => ({
  baseUrl: (process.env.AGENT_HUB_URL || '').trim().replace(/\/+$/, ''),
  serviceKey: (process.env.APP_SERVICE_KEY || '').trim(),
});

export const hubEnabled = () => {
  const { baseUrl, serviceKey } = hubConfig();
  return Boolean(baseUrl && serviceKey);
};
