const { existsSync, mkdirSync, copyFileSync, cpSync } = require('node:fs');
const { join, resolve } = require('node:path');

function sanitizePrNumber(prNumber) {
  const value = String(prNumber || '').trim();
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid PR number for Pages output: "${prNumber}"`);
  }
  return value;
}

/**
 * Builds a Pages URL only from an explicitly supplied, already-confirmed base
 * URL. The Action never infers that a deployment happened.
 */
function getPagesUrl({ baseUrl, prNumber }) {
  if (!baseUrl || !/^https:\/\//i.test(String(baseUrl))) return null;
  const safePrNumber = sanitizePrNumber(prNumber);
  return `${String(baseUrl).replace(/\/+$/, '')}/pr-explains/pr-${safePrNumber}/`;
}

/**
 * Copies optional existing site content into the staging directory, then writes
 * the PR report into its own subfolder. Copying is local only; deployment is the
 * caller's responsibility.
 */
function preparePagesFile({ generatedHtmlPath, pagesDistDir, prNumber, existingSiteDir }) {
  if (!generatedHtmlPath || !existsSync(generatedHtmlPath)) {
    throw new Error(`Generated HTML file not found: ${generatedHtmlPath}`);
  }

  const safePrNumber = sanitizePrNumber(prNumber);
  const distDir = resolve(pagesDistDir || 'pages-dist');

  if (existingSiteDir) {
    const sourceDir = resolve(existingSiteDir);
    if (!existsSync(sourceDir)) {
      throw new Error(`Existing Pages site directory not found: ${sourceDir}`);
    }
    cpSync(sourceDir, distDir, { recursive: true, force: false, errorOnExist: false });
  }

  const targetDir = join(distDir, 'pr-explains', `pr-${safePrNumber}`);
  mkdirSync(targetDir, { recursive: true });
  const targetFile = join(targetDir, 'index.html');
  copyFileSync(generatedHtmlPath, targetFile);
  return targetFile;
}

module.exports = {
  sanitizePrNumber,
  getPagesUrl,
  preparePagesFile
};
