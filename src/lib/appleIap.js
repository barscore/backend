import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';

// Apple's root certificates, downloaded from apple.com/certificateauthority.
// They are what makes the JWS verification meaningful: without pinning the
// chain to these, any well-formed JWS would be accepted.
const certsDir = join(dirname(fileURLToPath(import.meta.url)), '../../certs');
const ROOT_CA_FILES = [
  'AppleRootCA-G3.cer',
  'AppleRootCA-G2.cer',
  'AppleIncRootCertificate.cer',
  'AppleComputerRootCertificate.cer',
];

const BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.rabar.app';
// Numeric App Store id, from App Store Connect. Production verification needs
// it; sandbox does not.
const APP_APPLE_ID = process.env.APPLE_APP_APPLE_ID
  ? Number(process.env.APPLE_APP_APPLE_ID)
  : undefined;

let verifiers = null;

function loadVerifiers() {
  if (verifiers) return verifiers;

  let rootCAs;
  try {
    rootCAs = ROOT_CA_FILES.map((name) => readFileSync(join(certsDir, name)));
  } catch {
    // Missing certs mean we cannot verify anything, and accepting unverified
    // purchases would be worse than refusing them.
    verifiers = [];
    return verifiers;
  }

  const built = [];
  if (APP_APPLE_ID) {
    built.push(
      new SignedDataVerifier(rootCAs, true, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID),
    );
  }
  built.push(new SignedDataVerifier(rootCAs, true, Environment.SANDBOX, BUNDLE_ID));

  verifiers = built;
  return verifiers;
}

/**
 * Verifies a signed StoreKit 2 transaction and returns its decoded payload.
 *
 * A transaction is bound to one environment, and the app cannot be trusted to
 * say which — TestFlight builds produce sandbox transactions against the same
 * backend. So production is tried first and sandbox second; a transaction that
 * verifies under neither is rejected.
 */
export async function verifySignedTransaction(signedTransaction) {
  const available = loadVerifiers();
  if (available.length === 0) return null;

  for (const verifier of available) {
    try {
      return await verifier.verifyAndDecodeTransaction(signedTransaction);
    } catch {
      // Wrong environment for this verifier — try the next one.
    }
  }
  return null;
}
