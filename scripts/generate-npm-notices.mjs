import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const unknown = 'UNKNOWN';
const noticeFilePattern = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-].*)/i;
const inventoryConfigurations = [
  {
    title: 'WASHOPS AI — TRANSITIVE NPM LICENSE AND NOTICE INVENTORY',
    lockfilePath: join(repositoryRoot, 'package-lock.json'),
    packageRoot: repositoryRoot,
    outputPath: join(repositoryRoot, 'NPM_THIRD_PARTY_NOTICES.txt'),
    supplementalMaterialFiles: new Map(),
  },
  {
    title: 'WASHOPS AI VROOM RUNTIME — TRANSITIVE NPM LICENSE AND NOTICE INVENTORY',
    lockfilePath: join(repositoryRoot, 'infra/vroom/runtime-package/package-lock.json'),
    packageRoot: join(repositoryRoot, 'infra/vroom/runtime-package'),
    outputPath: join(repositoryRoot, 'infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt'),
    supplementalMaterialFiles: new Map([
      // cookie-signature@1.0.6 declares MIT and ships the complete MIT notice
      // under the "License" heading in Readme.md rather than in a dedicated
      // LICENSE file. Capture that exact lock-installed source explicitly.
      ['cookie-signature@1.0.6', ['Readme.md']],
    ]),
  },
];

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

function renderInventory({ title, lockfilePath, packageRoot, supplementalMaterialFiles }) {
  if (!existsSync(lockfilePath)) {
    throw new Error(
      `${relative(repositoryRoot, lockfilePath)} is required to generate the npm inventory.`,
    );
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
  const unmatchedSupplementalPackages = new Set(supplementalMaterialFiles.keys());
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
      const installedDirectory = join(packageRoot, lockPath);
      const manifestPath = join(installedDirectory, 'package.json');
      if (!existsSync(manifestPath)) {
        throw new Error(
          [
            `Install the exact dependency graph before generating notices; missing`,
            `${relative(repositoryRoot, manifestPath)}.`,
            packageRoot === repositoryRoot
              ? 'Run npm ci.'
              : `Run npm ci --prefix ${relative(repositoryRoot, packageRoot)} --omit=dev --ignore-scripts.`,
          ].join(' '),
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
      const supplementalKey = `${name}@${lockEntry.version}`;
      const supplementalFiles = supplementalMaterialFiles.get(supplementalKey) ?? [];
      if (supplementalFiles.length > 0) {
        unmatchedSupplementalPackages.delete(supplementalKey);
      }
      const materialFiles = new Set(
        readdirSync(installedDirectory).filter((fileName) => noticeFilePattern.test(fileName)),
      );
      for (const fileName of supplementalFiles) {
        materialFiles.add(fileName);
      }
      for (const fileName of [...materialFiles].sort(compareText)) {
        if (
          fileName.includes('/') ||
          fileName.includes('\\') ||
          fileName === '.' ||
          fileName === '..'
        ) {
          throw new Error(`Unsafe supplemental notice path for ${supplementalKey}: ${fileName}`);
        }

        const materialPath = join(installedDirectory, fileName);
        if (!existsSync(materialPath)) {
          throw new Error(
            `Supplemental notice source is missing for ${supplementalKey}: ${relative(
              repositoryRoot,
              materialPath,
            )}`,
          );
        }
        if (!lstatSync(materialPath).isFile()) {
          if (supplementalFiles.includes(fileName)) {
            throw new Error(
              `Supplemental notice source is not a regular file for ${supplementalKey}: ${relative(
                repositoryRoot,
                materialPath,
              )}`,
            );
          }
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

  if (unmatchedSupplementalPackages.size > 0) {
    throw new Error(
      `Supplemental notice package is absent from ${relative(
        repositoryRoot,
        lockfilePath,
      )}: ${[...unmatchedSupplementalPackages].sort(compareText).join(', ')}`,
    );
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
    title,
    '',
    'This file is generated. Do not edit it by hand.',
    'Generator: scripts/generate-npm-notices.mjs',
    'Regenerate: npm run licenses:generate',
    'Verify: npm run licenses:check',
    '',
    'SCOPE AND EVIDENCE',
    '',
    `Lockfile: ${relative(repositoryRoot, lockfilePath)} (lockfileVersion ${lockfile.lockfileVersion})`,
    `Root package: ${String(lockfile.name)}@${String(lockfile.version)}`,
    `Locked package paths: ${lockEntryCount}`,
    `Unique package name/version pairs: ${sortedPackages.length}`,
    `Unique installed license/notice texts: ${globalMaterials.size}`,
    `Packages with UNKNOWN declared license metadata: ${unknownLicenseCount}`,
    `Lock entries with UNKNOWN resolved artifact URL: ${unknownResolvedCount}`,
    `Lock entries with UNKNOWN integrity hash: ${unknownIntegrityCount}`,
    `Installed non-optional packages with no captured license/notice material: ${packageWithoutMaterialCount}`,
    `Optional package variants inventoried from lockfile only: ${optionalOnlyPackageCount}`,
    `Explicit supplemental notice sources: ${[...supplementalMaterialFiles.values()].reduce(
      (total, files) => total + files.length,
      0,
    )}`,
    '',
    'Every package-lock entry is listed below with its exact version and with',
    'the resolved artifact URL and integrity value when the lockfile records',
    'them. Omitted lockfile values are explicitly UNKNOWN. For non-optional',
    'packages, generation also validates',
    'the installed package name, version, and declared license against the',
    'lockfile and embeds every top-level LICENSE/LICENCE, COPYING, NOTICE, or',
    'COPYRIGHT file found in that installed package. A narrowly audited',
    'supplemental source is included only when a locked package places its',
    'complete license notice in another shipped file; that exact source path is',
    'recorded in the inventory. Embedded UTF-8 text has only line endings',
    'normalized to LF; each identifier is the SHA-256 of the original installed',
    'file bytes.',
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

const inventories = inventoryConfigurations.map((configuration) => ({
  configuration,
  generated: renderInventory(configuration),
}));

for (const { configuration, generated } of inventories) {
  const outputName = relative(repositoryRoot, configuration.outputPath);

  if (checkOnly) {
    if (!existsSync(configuration.outputPath)) {
      console.error(`${outputName} is missing. Run npm run licenses:generate.`);
      process.exitCode = 1;
    } else if (readFileSync(configuration.outputPath, 'utf8') !== generated) {
      console.error(`${outputName} is stale. Run npm run licenses:generate and commit the result.`);
      process.exitCode = 1;
    } else {
      console.log(`${outputName} matches its locked dependency graph.`);
    }
  } else {
    writeFileSync(configuration.outputPath, generated);
    console.log(`Wrote ${outputName} (${Buffer.byteLength(generated)} bytes).`);
  }
}
