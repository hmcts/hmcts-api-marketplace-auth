// Secrets come from the `config` package, populated either by plain
// environment variables (Render, local dev - see
// config/custom-environment-variables.json) or, once mounted, real Key
// Vault secret files via @hmcts/properties-volume - the same file-mounted
// secrets an AKS pod gets via the Helm chart's nodejs.keyVaults config
// (charts/amp-auth/values.yaml). addTo() is a safe no-op when the mount
// point doesn't exist, so this works unmodified on both.
//
// Node caches modules, so no matter which file requires this one first,
// addTo() runs exactly once, before anything reads a secret.
const config = require('config');
require('@hmcts/properties-volume').addTo(config);

function getSecret(name) {
  if (!config.has('secrets.amp')) return undefined;
  return config.get('secrets.amp')[name];
}

module.exports = { getSecret };
