/** builds metadata for release evidence; the deployer must verify the image digest from the registry/deployment themselves */
import { assertC360ContactPointRuntime } from '@d-contact/contact-points/runtime-manifest';
import { C360_PARSER_INTEGRITY } from './customer-360-write-runtime.js';

const imageDigest = process.env.C360_IMAGE_DIGEST;
if (!imageDigest || !/^sha256:[0-9a-f]{64}$/.test(imageDigest))
  throw new Error('C360_IMAGE_DIGEST must be the digest of the image to be deployed');
const runtime = assertC360ContactPointRuntime();
process.stdout.write(
  `${JSON.stringify({
    imageDigest,
    nodeVersion: runtime.nodeVersion,
    icuVersion: process.versions.icu,
    unicodeVersion: process.versions.unicode,
    normalizationVersions: runtime.normalizationVersions,
    phoneMetadataSha256: runtime.phoneMetadataSha256,
    packageIntegrity: C360_PARSER_INTEGRITY,
  })}\n`,
);
