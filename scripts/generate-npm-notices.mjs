import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockfilePath = join(repositoryRoot, 'package-lock.json');
const outputPath = join(repositoryRoot, 'NPM_THIRD_PARTY_NOTICES.txt');
const checkOnly = process.argv.includes('--check');
const unknown = 'UNKNOWN';
const noticeFilePattern = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-].*)/i;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const markerIndex = lockPath.lastIndexOf(marker);
  return lockPath.slice(markerIndex + marker.length);
}

function normalizeDeclaredLicense(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (value === undefined || value === null) {
    return unknown;
  }

  // Preserve unusual legacy package metadata exactly instead of interpreting it
  // as a modern SPDX expression.
  return JSON.stringify(value);
}

function normalizeNoticeText(buffer, sourcePath) {
  if (buffer.includes(0)) {
    throw new Error(`Refusing to embed binary notice material: ${sourcePath}`);
  }

  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  return decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd();
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function renderInventory() {
  if (!existsSync(lockfilePath)) {
    throw new Error('package-lock.json is required to generate the npm inventory.');
  }

  const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
  if (lockfile.lockfileVersion !== 3) {
    throw new Error(
      `Expected npm lockfileVersion 3, received ${String(lockfile.lockfileVersion)}.`,
    );
  }

  const rootPackage = lockfile.packages?.[''];
  if (!rootPackage) {
    throw new Error('The root package record is missing from package-lock.json.');
  }

  const directRuntime = new Set(Object.keys(rootPackage.dependencies ?? {}));
  const directDevelopment = new Set(Object.keys(rootPackage.devDependencies ?? {}));
  const directOptional = new Set(Object.keys(rootPackage.optionalDependencies ?? {}));
  const packages = new Map();
  let lockEntryCount = 0;

  for (const [lockPath, lockEntry] of Object.entries(lockfile.packages ?? {})) {
    if (!lockPath.startsWith('node_modules/') || !lockEntry.version) {
      continue;
    }

    lockEntryCount += 1;
    const name = packageNameFromLockPath(lockPath);
    const key = `${name}\u0000${lockEntry.version}`;
    const record = packages.get(key) ?? {
      name,
      version: lockEntry.version,
      entries: [],
      installedEvidence: [],
      materials: new Map(),
    };

    if (record.name !== name || record.version !== lockEntry.version) {
      throw new Error(`Inconsistent package identity for ${lockPath}.`);
    }

    record.entries.push({
      path: lockPath,
      license: normalizeDeclaredLicense(lockEntry.license),
      resolved: lockEntry.resolved ?? unknown,
      integrity: lockEntry.integrity ?? unknown,
      development: lockEntry.dev === true,
      optional: lockEntry.optional === true,
    });

    // Optional entries in this lock are platform-specific build binaries.
    // Their install presence changes with OS/CPU, so their published lock metadata
    // is inventoried but host-specific files are deliberately not folded into the
    // committed artifact.
    if (!lockEntry.optional) {
      const installedDirectory = join(repositoryRoot, lockPath);
      const manifestPath = join(installedDirectory, 'package.json');
      if (!existsSync(manifestPath)) {
        throw new Error(
          `Run npm ci before generating notices; missing ${relative(repositoryRoot, manifestPath)}.`,
        );
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const manifestLicense = normalizeDeclaredLicense(manifest.license);
      const lockLicense = normalizeDeclaredLicense(lockEntry.license);
      if (
        manifest.name !== name ||
        manifest.version !== lockEntry.version ||
        manifestLicense !== lockLicense
      ) {
        throw new Error(
          [
            `Installed metadata does not match package-lock.json for ${lockPath}.`,
            `lock=${name}@${lockEntry.version} license=${lockLicense}`,
            `installed=${String(manifest.name)}@${String(manifest.version)} license=${manifestLicense}`,
          ].join(' '),
        );
      }

      record.installedEvidence.push(lockPath);
      for (const fileName of readdirSync(installedDirectory).sort(compareText)) {
        if (!noticeFilePattern.test(fileName)) {
          continue;
        }

        const materialPath = join(installedDirectory, fileName);
        if (!lstatSync(materialPath).isFile()) {
          continue;
        }

        const buffer = readFileSync(materialPath);
        const digest = sha256(buffer);
        const material = record.materials.get(digest) ?? {
          digest,
          text: normalizeNoticeText(buffer, materialPath),
          sourceFiles: [],
        };
        material.sourceFiles.push(relative(repositoryRoot, materialPath));
        record.materials.set(digest, material);
      }
    }

    packages.set(key, record);
  }

  const sortedPackages = [...packages.values()].sort((left, right) => {
    return compareText(left.name, right.name) || compareText(left.version, right.version);
  });
  const globalMaterials = new Map();
  let unknownLicenseCount = 0;
  let unknownResolvedCount = 0;
  let unknownIntegrityCount = 0;
  let packageWithoutMaterialCount = 0;
  let optionalOnlyPackageCount = 0;

  for (const record of sortedPackages) {
    const declaredLicenses = new Set(record.entries.map((entry) => entry.license));
    if (declaredLicenses.has(unknown)) {
      unknownLicenseCount += 1;
    }
    unknownResolvedCount += record.entries.filter((entry) => entry.resolved === unknown).length;
    unknownIntegrityCount += record.entries.filter((entry) => entry.integrity === unknown).length;
    if (record.installedEvidence.length === 0) {
      optionalOnlyPackageCount += 1;
    } else if (record.materials.size === 0) {
      packageWithoutMaterialCount += 1;
    }

    for (const material of record.materials.values()) {
      const globalMaterial = globalMaterials.get(material.digest) ?? {
        digest: material.digest,
        text: material.text,
        uses: [],
      };
      if (globalMaterial.text !== material.text) {
        throw new Error(`SHA-256 collision while processing notice material ${material.digest}.`);
      }
      globalMaterial.uses.push({
        package: `${record.name}@${record.version}`,
        sourceFiles: material.sourceFiles.sort(compareText),
      });
      globalMaterials.set(material.digest, globalMaterial);
    }
  }

  const lines = [
    'STORYOPS AI — TRANSITIVE NPM LICENSE AND NOTICE INVENTORY',
    '',
    'This file is generated. Do not edit it by hand.',
    'Generator: scripts/generate-npm-notices.mjs',
    'Regenerate: npm run licenses:generate',
    'Verify: npm run licenses:check',
    '',
    'SCOPE AND EVIDENCE',
    '',
    `Lockfile: package-lock.json (lockfileVersion ${lockfile.lockfileVersion})`,
    `Root package: ${String(lockfile.name)}@${String(lockfile.version)}`,
    `Locked package paths: ${lockEntryCount}`,
    `Unique package name/version pairs: ${sortedPackages.length}`,
    `Unique installed license/notice texts: ${globalMaterials.size}`,
    `Packages with UNKNOWN declared license metadata: ${unknownLicenseCount}`,
    `Lock entries with UNKNOWN resolved artifact URL: ${unknownResolvedCount}`,
    `Lock entries with UNKNOWN integrity hash: ${unknownIntegrityCount}`,
    `Installed non-optional packages with no top-level license/notice file: ${packageWithoutMaterialCount}`,
    `Optional package variants inventoried from lockfile only: ${optionalOnlyPackageCount}`,
    '',
    'Every package-lock entry is listed below with its exact version and with',
    'the resolved artifact URL and integrity value when the lockfile records',
    'them. Omitted lockfile values are explicitly UNKNOWN. For non-optional',
    'packages, generation also validates',
    'the installed package name, version, and declared license against the',
    'lockfile and embeds every top-level LICENSE/LICENCE, COPYING, NOTICE, or',
    'COPYRIGHT file found in that installed package. Embedded UTF-8 text has',
    'only line endings normalized to LF; each identifier is the SHA-256 of the',
    'original installed file bytes.',
    '',
    'Optional dependencies in this graph are platform-specific build variants.',
    'They are intentionally represented from package-lock.json only so this',
    'committed inventory is stable across supported build hosts. No license',
    'text is inferred from a similarly named package. UNKNOWN means the source',
    'metadata did not declare the value; it is never silently guessed.',
    '',
    'This generated inventory is engineering evidence, not legal advice or a',
    'substitute for release counsel review.',
    '',
    'PACKAGE INVENTORY',
    '',
  ];

  for (const record of sortedPackages) {
    const declaredLicenses = [...new Set(record.entries.map((entry) => entry.license))].sort(
      compareText,
    );
    const allDevelopment = record.entries.every((entry) => entry.development);
    const anyRuntime = record.entries.some((entry) => !entry.development);
    const allOptional = record.entries.every((entry) => entry.optional);
    const directScopes = [];
    if (directRuntime.has(record.name)) {
      directScopes.push('direct-runtime');
    }
    if (directDevelopment.has(record.name)) {
      directScopes.push('direct-development');
    }
    if (directOptional.has(record.name)) {
      directScopes.push('direct-optional');
    }
    if (directScopes.length === 0) {
      directScopes.push('transitive');
    }

    lines.push(`${record.name}@${record.version}`);
    lines.push(`  declared-license: ${declaredLicenses.join(' | ')}`);
    lines.push(
      `  scope: ${directScopes.join(', ')}; graph: ${anyRuntime ? 'runtime' : allDevelopment ? 'development-only' : unknown}; optional-only: ${allOptional ? 'yes' : 'no'}`,
    );
    if (record.installedEvidence.length === 0) {
      lines.push(
        '  installed-evidence: NOT EXTRACTED — optional platform variant; metadata is lockfile-only',
      );
      lines.push('  license-material: NOT EXTRACTED — no text inferred');
    } else {
      lines.push(`  installed-evidence: ${record.installedEvidence.sort(compareText).join(', ')}`);
      const materialIds = [...record.materials.keys()].sort(compareText);
      lines.push(
        `  license-material: ${materialIds.length > 0 ? materialIds.map((digest) => `sha256:${digest}`).join(', ') : 'NOT FOUND IN INSTALLED PACKAGE'}`,
      );
    }

    for (const entry of record.entries.sort((left, right) => compareText(left.path, right.path))) {
      lines.push(`  lock-path: ${entry.path}`);
      lines.push(`    resolved: ${entry.resolved}`);
      lines.push(`    integrity: ${entry.integrity}`);
      lines.push(
        `    flags: ${entry.development ? 'development' : 'runtime'}, ${entry.optional ? 'optional' : 'required'}`,
      );
    }
    lines.push('');
  }

  lines.push('EMBEDDED LICENSE AND NOTICE MATERIAL');
  lines.push('');

  for (const material of [...globalMaterials.values()].sort((left, right) =>
    compareText(left.digest, right.digest),
  )) {
    lines.push(`----- BEGIN MATERIAL sha256:${material.digest} -----`);
    for (const use of material.uses.sort((left, right) =>
      compareText(left.package, right.package),
    )) {
      lines.push(`Package: ${use.package}; installed file(s): ${use.sourceFiles.join(', ')}`);
    }
    lines.push('');
    lines.push(material.text);
    lines.push(`----- END MATERIAL sha256:${material.digest} -----`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

const generated = renderInventory();

if (checkOnly) {
  if (!existsSync(outputPath)) {
    console.error('NPM_THIRD_PARTY_NOTICES.txt is missing. Run npm run licenses:generate.');
    process.exitCode = 1;
  } else if (readFileSync(outputPath, 'utf8') !== generated) {
    console.error(
      'NPM_THIRD_PARTY_NOTICES.txt is stale. Run npm run licenses:generate and commit the result.',
    );
    process.exitCode = 1;
  } else {
    console.log('NPM_THIRD_PARTY_NOTICES.txt matches the locked dependency graph.');
  }
} else {
  writeFileSync(outputPath, generated);
  console.log(
    `Wrote ${relative(repositoryRoot, outputPath)} (${Buffer.byteLength(generated)} bytes).`,
  );
}
