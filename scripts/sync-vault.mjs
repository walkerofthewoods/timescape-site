import { existsSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const siteDirectory = resolve(scriptDirectory, "..");
const vaultDirectory = resolve(
  process.env.TIMESCAPE_VAULT ?? "C:\\Users\\walke\\OneDrive\\Documents\\The Timescape",
);
const playerFacingDirectory = join(vaultDirectory, "z_player_facing");
const contentDirectory = join(siteDirectory, "content");

function walkFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function normalizeReference(reference) {
  let normalized = reference.trim().replaceAll("/", "\\");
  normalized = normalized.split("#")[0];
  normalized = normalized.split("|")[0];
  return normalized;
}

function resolveAssetReference(reference, markdownFile) {
  const normalized = normalizeReference(reference);
  if (!normalized) return null;

  const vaultCandidates = [
    join(vaultDirectory, normalized),
    join(dirname(markdownFile), normalized),
  ];

  return vaultCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

if (!existsSync(playerFacingDirectory)) {
  console.error(`Player-facing directory not found: ${playerFacingDirectory}`);
  process.exit(1);
}

rmSync(contentDirectory, { recursive: true, force: true });
mkdirSync(contentDirectory, { recursive: true });
cpSync(playerFacingDirectory, contentDirectory, {
  recursive: true,
  dereference: true,
});

const landingPage = `---
title: The Timescape
---

- [Atlas of Time](<Atlas of Time/Atlas of Time.md>)
- [Maps](<Atlas of Time/Maps/Maps.md>)
- [Campaigns](<Campaigns/Campaigns.md>)
- [Session Journals](<Session Journals/Session Journals.md>)
`;

writeFileSync(join(contentDirectory, "index.md"), landingPage, "utf8");

const markdownFiles = walkFiles(playerFacingDirectory).filter(
  (file) => extname(file).toLowerCase() === ".md",
);

const missingReferences = new Set();
const requiredAssets = new Set();

for (const markdownFile of markdownFiles) {
  const sourceMarkdown = readFileSync(markdownFile, "utf8");

  const wikilinkPattern = /!?\[\[([^\]]+)\]\]/g;
  for (const match of sourceMarkdown.matchAll(wikilinkPattern)) {
    const reference = normalizeReference(match[1]);
    if (!reference) continue;

    if (match[0].startsWith("!") || reference.includes(".")) {
      const resolvedAsset = resolveAssetReference(reference, markdownFile);
      if (resolvedAsset) {
        requiredAssets.add(resolvedAsset);
      } else if (reference.includes(".")) {
        missingReferences.add(reference);
      }
    }
  }

  const markdownAssetPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of sourceMarkdown.matchAll(markdownAssetPattern)) {
    const resolvedAsset = resolveAssetReference(match[1], markdownFile);
    if (resolvedAsset) {
      requiredAssets.add(resolvedAsset);
    } else {
      missingReferences.add(normalizeReference(match[1]));
    }
  }

  const imageBasePattern = /^\s*-\s*(?:path:\s*)?(.+\.(?:png|jpe?g|gif|webp|avif|svg))\s*$/gim;
  for (const match of sourceMarkdown.matchAll(imageBasePattern)) {
    const resolvedAsset = resolveAssetReference(match[1], markdownFile);
    if (resolvedAsset) {
      requiredAssets.add(resolvedAsset);
    } else {
      missingReferences.add(normalizeReference(match[1]));
    }
  }

  const markerPattern = /^\s*markers:\s*(.+\.(?:json))\s*$/gim;
  for (const match of sourceMarkdown.matchAll(markerPattern)) {
    const resolvedAsset = resolveAssetReference(match[1], markdownFile);
    if (resolvedAsset) {
      requiredAssets.add(resolvedAsset);
    } else {
      missingReferences.add(normalizeReference(match[1]));
    }
  }
}

for (const sourceAsset of requiredAssets) {
  const relativeAsset = relative(vaultDirectory, sourceAsset);
  const destinationAsset = join(contentDirectory, relativeAsset);
  mkdirSync(dirname(destinationAsset), { recursive: true });
  cpSync(sourceAsset, destinationAsset, { dereference: true });
}

const copiedPages = walkFiles(contentDirectory).filter(
  (file) => extname(file).toLowerCase() === ".md",
).length;

console.log(`Synced ${copiedPages} player-facing Markdown pages.`);
console.log(`Copied ${requiredAssets.size} referenced assets.`);

if (missingReferences.size > 0) {
  console.error("Missing references:");
  for (const reference of [...missingReferences].sort()) {
    console.error(`- ${reference}`);
  }
  process.exitCode = 1;
}
